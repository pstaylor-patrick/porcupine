/**
 * Pi extension: runs the hooks in ~/.claude/settings.json with Claude Code
 * semantics so change fabric guards porcupine sessions the way it guards
 * Claude Code.
 *
 *   session_start      -> SessionStart (stdout / additionalContext become context)
 *   input              -> UserPromptSubmit (exit 2 or decision block drops the prompt)
 *   before_agent_start -> injects the context collected above
 *   tool_call          -> PreToolUse (exit 2 / deny / block block the call; ask confirms)
 *   tool_result        -> PostToolUse (block reasons are appended to the result)
 *   agent_end          -> Stop (block sends the reason as a follow-up, max 3 in a row)
 *
 * Timeouts and other failures fail open with a notice. Carries its own
 * minimal types; pi resolves nothing from this file.
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandsFor, HooksSource, runEvent, DEFAULT_TIMEOUT_SEC, type HookEventName, type HooksConfig, type Outcome } from "./hooks.js";
import { claudeToolInput, claudeToolName, claudeToolResponse, sessionSource } from "./map.js";
import { resolveSessionId, SESSION_ENTRY } from "./session-id.js";

/** Title prefix for hook "ask" confirms; ui-autocancel lets these wait for the browser. Keep in sync there. */
export const HOOK_CONFIRM_PREFIX = "cf hook: ";
export const MAX_STOP_BLOCKS = 3;
const CONTEXT_TYPE = "porcupine_claude_hooks";

interface Entry {
  type: string;
  customType?: string;
  data?: unknown;
}
export interface Ctx {
  cwd?: string;
  hasUI?: boolean;
  ui?: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean>;
  };
  sessionManager?: { getEntries(): Entry[]; getSessionId?(): string; getSessionFile?(): string | undefined };
  abort?(): void;
}
type Rec = Record<string, unknown>;
type Handler = (event: Rec, ctx: Ctx) => unknown;
export interface Api {
  on(event: string, handler: Handler): unknown;
  appendEntry(customType: string, data?: unknown): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

export interface BridgeOptions {
  env?: Record<string, string | undefined>;
  settingsPath?: string;
  cwd?: string;
}

/** A tool call's input as a record; arrays and primitives become empty. */
function toolInput(raw: unknown): Rec {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Rec) : {};
}

export default function claudeHooks(pi: Api, opts: BridgeOptions = {}): void {
  const env = opts.env ?? process.env;
  const source = new HooksSource(opts.settingsPath ?? join(env.HOME ?? homedir(), ".claude", "settings.json"));
  let sessionId: string | null = null;
  let pendingContext: string[] = [];
  let stopBlocks = 0;

  const cwdOf = (ctx: Ctx): string => opts.cwd ?? ctx.cwd ?? process.cwd();
  const notify = (ctx: Ctx, msg: string, level: "info" | "warning" | "error" = "warning"): void => {
    if (ctx.hasUI !== false) ctx.ui?.notify(msg, level);
  };
  const ensureId = (ctx: Ctx): string => {
    if (sessionId) return sessionId;
    const r = resolveSessionId(env, ctx.sessionManager?.getEntries() ?? [], ctx.sessionManager?.getSessionId?.() ?? null);
    sessionId = r.id;
    if (r.persist) pi.appendEntry(SESSION_ENTRY, { id: r.id });
    const file = env.PORCUPINE_CF_ID_FILE;
    if (file) {
      try {
        writeFileSync(file, `${r.id}\n`, { mode: 0o600 });
      } catch {
        // The merge-mode picker falls back to the registry id.
      }
    }
    return r.id;
  };
  const fire = async (ctx: Ctx, ev: HookEventName, target: string | null, extra: Rec): Promise<Outcome | null> => {
    const cfg: HooksConfig = source.get();
    const cmds = commandsFor(cfg, ev, target);
    if (!cmds.length) return null;
    const cwd = cwdOf(ctx);
    const payload: Rec = {
      session_id: ensureId(ctx),
      transcript_path: ctx.sessionManager?.getSessionFile?.() ?? "",
      cwd,
      hook_event_name: ev,
      ...extra,
    };
    const out = await runEvent(cmds, ev, payload, { cwd, env: env as NodeJS.ProcessEnv });
    for (const n of out.notices) notify(ctx, n);
    return out;
  };

  pi.on("session_start", async (event, ctx) => {
    sessionId = null;
    ensureId(ctx);
    const out = await fire(ctx, "SessionStart", sessionSource(event.reason), { source: sessionSource(event.reason) });
    if (out?.context.length) pendingContext.push(...out.context);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") stopBlocks = 0;
    const prompt = typeof event.text === "string" ? event.text : "";
    const out = await fire(ctx, "UserPromptSubmit", null, { prompt });
    if (!out) return { action: "continue" };
    if (out.decision === "block" || out.decision === "deny") {
      notify(ctx, `prompt blocked by hook: ${out.reason}`, "error");
      return { action: "handled" };
    }
    if (out.context.length) pendingContext.push(...out.context);
    return { action: "continue" };
  });

  pi.on("before_agent_start", () => {
    if (!pendingContext.length) return undefined;
    const text = pendingContext.join("\n\n");
    pendingContext = [];
    return { message: { customType: CONTEXT_TYPE, content: text, display: false } };
  });

  pi.on("tool_call", async (event, ctx) => {
    const piName = typeof event.toolName === "string" ? event.toolName : "";
    const name = claudeToolName(piName);
    const input = toolInput(event.input);
    const out = await fire(ctx, "PreToolUse", name, { tool_name: name, tool_input: claudeToolInput(piName, input), tool_use_id: event.toolCallId });
    if (!out) return undefined;
    if (out.decision === "deny" || out.decision === "block") return { block: true, reason: out.reason };
    if (out.decision === "ask") {
      const ok = ctx.ui
        ? await ctx.ui.confirm(`${HOOK_CONFIRM_PREFIX}allow ${name}?`, out.reason || `A hook asks before ${name}.`, {
            timeout: DEFAULT_TIMEOUT_SEC * 1000,
          })
        : false;
      if (!ok) return { block: true, reason: out.reason || "denied by user" };
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const piName = typeof event.toolName === "string" ? event.toolName : "";
    const name = claudeToolName(piName);
    const input = toolInput(event.input);
    const out = await fire(ctx, "PostToolUse", name, {
      tool_name: name,
      tool_input: claudeToolInput(piName, input),
      tool_response: claudeToolResponse(piName, event.content, event.details, event.isError === true),
      tool_use_id: event.toolCallId,
    });
    if (!out) return undefined;
    const extra = [...(out.decision === "block" || out.decision === "deny" ? [out.reason] : []), ...out.context].filter(Boolean);
    if (!extra.length) return undefined;
    const content = Array.isArray(event.content) ? (event.content as unknown[]) : [];
    return { content: [...content, { type: "text", text: `\n[PostToolUse hook]\n${extra.join("\n")}` }] };
  });

  pi.on("agent_end", async (_event, ctx) => {
    const out = await fire(ctx, "Stop", null, { stop_hook_active: stopBlocks > 0 });
    if (out && (out.decision === "block" || out.decision === "deny") && !out.stop && stopBlocks < MAX_STOP_BLOCKS) {
      stopBlocks++;
      pi.sendUserMessage(out.reason, { deliverAs: "followUp" });
      return;
    }
    stopBlocks = 0;
  });
}
