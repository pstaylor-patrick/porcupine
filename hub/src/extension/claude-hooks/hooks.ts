/**
 * Claude Code hook semantics, independent of pi: reading the "hooks" block of
 * ~/.claude/settings.json, matching, running each command with JSON on stdin,
 * and folding the results into one decision.
 *
 * Exit 0 with JSON stdout is parsed; exit 0 with plain stdout is context for
 * SessionStart and UserPromptSubmit. Exit 2 blocks with stderr as the reason.
 * Any other exit, a spawn error or a timeout fails open with a notice.
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

export type HookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

export interface HookCommand {
  command: string;
  timeoutSec?: number;
}
export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
export type HooksConfig = Partial<Record<HookEventName, HookGroup[]>>;

/** Claude Code's default per-command timeout. */
export const DEFAULT_TIMEOUT_SEC = 60;
const EVENTS: HookEventName[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keeps only command hooks of the events the bridge maps; anything malformed is dropped. */
export function parseHooks(settings: unknown): HooksConfig {
  const out: HooksConfig = {};
  const hooks = isRec(settings) ? settings.hooks : undefined;
  if (!isRec(hooks)) return out;
  for (const ev of EVENTS) {
    const groups = hooks[ev];
    if (!Array.isArray(groups)) continue;
    const parsed: HookGroup[] = [];
    for (const g of groups) {
      if (!isRec(g) || !Array.isArray(g.hooks)) continue;
      const cmds: HookCommand[] = [];
      for (const h of g.hooks) {
        if (!isRec(h) || (h.type !== undefined && h.type !== "command") || typeof h.command !== "string") continue;
        cmds.push(typeof h.timeout === "number" && h.timeout > 0 ? { command: h.command, timeoutSec: h.timeout } : { command: h.command });
      }
      if (cmds.length) parsed.push(typeof g.matcher === "string" ? { matcher: g.matcher, hooks: cmds } : { hooks: cmds });
    }
    if (parsed.length) out[ev] = parsed;
  }
  return out;
}

/** Re-reads the settings file when its mtime changes. A missing or broken file means no hooks. */
export class HooksSource {
  private mtime = -1;
  private cached: HooksConfig = {};
  constructor(private readonly path: string) {}

  get(): HooksConfig {
    let m: number;
    try {
      m = statSync(this.path).mtimeMs;
    } catch {
      this.mtime = -1;
      this.cached = {};
      return this.cached;
    }
    if (m !== this.mtime) {
      this.mtime = m;
      try {
        this.cached = parseHooks(JSON.parse(readFileSync(this.path, "utf8")));
      } catch {
        this.cached = {};
      }
    }
    return this.cached;
  }
}

/** "" / "*" / absent match everything; otherwise an anchored regex (so "Edit|Write" works). */
export function matches(matcher: string | undefined, target: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(target);
  } catch {
    return matcher === target;
  }
}

export function commandsFor(cfg: HooksConfig, ev: HookEventName, target: string | null): HookCommand[] {
  const groups = cfg[ev] ?? [];
  return groups.filter((g) => target === null || matches(g.matcher, target)).flatMap((g) => g.hooks);
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const OUTPUT_LIMIT = 1024 * 1024;

export function runCommand(
  command: string,
  input: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const child = spawn("sh", ["-c", command], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(null);
    }, opts.timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += c.toString("utf8");
    });
    child.on("error", (e) => {
      stderr += e.message;
      finish(-1);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

export type Decision = "allow" | "deny" | "ask" | "block" | null;

export interface Outcome {
  /** Strongest decision across commands: deny/block > ask > allow. */
  decision: Decision;
  reason: string;
  /** Context to give the model (additionalContext plus plain stdout where Claude Code uses it). */
  context: string[];
  /** Failures that fell open: timeouts, non-2 nonzero exits, bad JSON. */
  notices: string[];
  /** A command asked to stop the session (continue: false). */
  stop: boolean;
}

const RANK: Record<Exclude<Decision, null>, number> = { allow: 1, ask: 2, deny: 3, block: 3 };

/** Folds one command's result into the outcome per Claude Code semantics. */
export function interpret(ev: HookEventName, cmd: string, r: RunResult, out: Outcome): void {
  const raise = (d: Exclude<Decision, null>, reason: string): void => {
    if (out.decision === null || RANK[d] > RANK[out.decision]) {
      out.decision = d;
      out.reason = reason;
    } else if (RANK[d] === RANK[out.decision] && reason) {
      out.reason = out.reason ? `${out.reason}\n${reason}` : reason;
    }
  };
  if (r.timedOut) {
    out.notices.push(`hook timed out, allowed: ${cmd}`);
    return;
  }
  if (r.code === 2) {
    raise(ev === "PreToolUse" ? "deny" : "block", r.stderr.trim() || "blocked by hook");
    return;
  }
  if (r.code !== 0) {
    out.notices.push(`hook failed (exit ${String(r.code)}), allowed: ${cmd}${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : ""}`);
    return;
  }
  const text = r.stdout.trim();
  if (!text) return;
  let j: unknown = undefined;
  if (text.startsWith("{")) {
    try {
      j = JSON.parse(text);
    } catch {
      j = undefined;
    }
  }
  if (!isRec(j)) {
    if (ev === "SessionStart" || ev === "UserPromptSubmit") out.context.push(text);
    return;
  }
  if (j.continue === false) {
    out.stop = true;
    raise("block", typeof j.stopReason === "string" ? j.stopReason : "stopped by hook");
  }
  const hso = isRec(j.hookSpecificOutput) ? j.hookSpecificOutput : {};
  if (typeof hso.additionalContext === "string" && hso.additionalContext) out.context.push(hso.additionalContext);
  const pd = hso.permissionDecision;
  const pdr = typeof hso.permissionDecisionReason === "string" ? hso.permissionDecisionReason : "";
  const reason = typeof j.reason === "string" ? j.reason : "";
  if (pd === "deny" || pd === "ask" || pd === "allow") raise(pd, pdr || reason);
  if (j.decision === "block") raise("block", reason || "blocked by hook");
  if (j.decision === "approve") raise("allow", reason);
}

export interface RunEventOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  defaultTimeoutSec?: number;
}

/** Runs every matching command in parallel, as Claude Code does, and folds the results. */
export async function runEvent(cmds: HookCommand[], ev: HookEventName, payload: Rec, opts: RunEventOptions): Promise<Outcome> {
  const out: Outcome = { decision: null, reason: "", context: [], notices: [], stop: false };
  if (!cmds.length) return out;
  const input = JSON.stringify(payload);
  const env = { ...opts.env, CLAUDE_PROJECT_DIR: opts.cwd };
  const results = await Promise.all(
    cmds.map((c) =>
      runCommand(c.command, input, { cwd: opts.cwd, env, timeoutMs: (c.timeoutSec ?? opts.defaultTimeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000 }),
    ),
  );
  results.forEach((r, i) => interpret(ev, (cmds[i] as HookCommand).command, r, out));
  return out;
}
