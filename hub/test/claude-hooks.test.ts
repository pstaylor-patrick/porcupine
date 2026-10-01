import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import claudeHooks, { MAX_STOP_BLOCKS, type Api, type Ctx } from "../src/extension/claude-hooks/index.js";
import { commandsFor, matches, parseHooks, runEvent } from "../src/extension/claude-hooks/hooks.js";
import { claudeToolInput, claudeToolName } from "../src/extension/claude-hooks/map.js";
import { resolveSessionId, SESSION_ENTRY } from "../src/extension/claude-hooks/session-id.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "porcupine-hooks-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function settings(hooks: unknown): string {
  const p = join(dir, "settings.json");
  writeFileSync(p, JSON.stringify({ hooks }));
  return p;
}

type Handler = (event: Record<string, unknown>, ctx: Ctx) => unknown;
function fakePi(): { api: Api; handlers: Map<string, Handler>; entries: { customType: string; data: unknown }[]; sent: string[] } {
  const handlers = new Map<string, Handler>();
  const entries: { customType: string; data: unknown }[] = [];
  const sent: string[] = [];
  return {
    handlers,
    entries,
    sent,
    api: {
      on: (e, h) => handlers.set(e, h),
      appendEntry: (customType, data) => entries.push({ customType, data }),
      sendUserMessage: (c) => sent.push(c),
    },
  };
}

function ctx(notices: string[] = [], confirm = false): Ctx {
  return {
    cwd: dir,
    hasUI: true,
    ui: { notify: (m) => notices.push(m), confirm: () => Promise.resolve(confirm) },
    sessionManager: { getEntries: () => [], getSessionId: () => "pi-uuid", getSessionFile: () => "/tmp/t.jsonl" },
  };
}

describe("mapping", () => {
  it("maps pi tool names and inputs to Claude Code's", () => {
    expect(claudeToolName("bash")).toBe("Bash");
    expect(claudeToolName("edit")).toBe("Edit");
    expect(claudeToolName("write")).toBe("Write");
    expect(claudeToolName("read")).toBe("Read");
    expect(claudeToolName("my_tool")).toBe("my_tool");
    expect(claudeToolInput("bash", { command: "ls" })).toEqual({ command: "ls" });
    expect(claudeToolInput("write", { path: "a.txt", content: "x" })).toEqual({ file_path: "a.txt", content: "x" });
    expect(claudeToolInput("edit", { path: "a", edits: [{ oldText: "o", newText: "n" }] })).toMatchObject({
      file_path: "a",
      old_string: "o",
      new_string: "n",
    });
  });
});

describe("matchers", () => {
  it("treats empty and * as match-all and others as anchored regex", () => {
    expect(matches(undefined, "Bash")).toBe(true);
    expect(matches("", "Bash")).toBe(true);
    expect(matches("*", "Bash")).toBe(true);
    expect(matches("Edit|Write", "Write")).toBe(true);
    expect(matches("Edit|Write", "Bash")).toBe(false);
    expect(matches("Bash", "BashOutput")).toBe(false);
    expect(matches("Notebook.*", "NotebookEdit")).toBe(true);
  });

  it("parses settings and selects commands by matcher", () => {
    const cfg = parseHooks({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "a" }] },
          { hooks: [{ type: "command", command: "b", timeout: 5 }] },
          { hooks: [{ type: "prompt", prompt: "x" }] },
        ],
        Unknown: [{ hooks: [{ type: "command", command: "z" }] }],
      },
    });
    expect(commandsFor(cfg, "PreToolUse", "Bash").map((c) => c.command)).toEqual(["a", "b"]);
    expect(commandsFor(cfg, "PreToolUse", "Read")).toEqual([{ command: "b", timeoutSec: 5 }]);
  });
});

describe("runEvent", () => {
  const opts = (): { cwd: string; env: NodeJS.ProcessEnv } => ({ cwd: dir, env: { PATH: process.env.PATH } });

  it("blocks on exit 2 with stderr as the reason", async () => {
    const s = script("deny.sh", 'echo "no pushes" >&2; exit 2');
    const out = await runEvent([{ command: s }], "PreToolUse", { tool_name: "Bash" }, opts());
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("no pushes");
  });

  it("blocks on JSON permissionDecision deny and on decision block", async () => {
    const a = script("a.sh", `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"nope"}}'`);
    const b = script("b.sh", `echo '{"decision":"block","reason":"stop"}'`);
    expect((await runEvent([{ command: a }], "PreToolUse", {}, opts())).decision).toBe("deny");
    const out = await runEvent([{ command: b }], "Stop", {}, opts());
    expect(out).toMatchObject({ decision: "block", reason: "stop" });
  });

  it("fails open with a notice on timeout and on other exit codes", async () => {
    const slow = script("slow.sh", "sleep 5");
    const bad = script("bad.sh", "echo oops >&2; exit 1");
    const out = await runEvent([{ command: slow, timeoutSec: 0.2 }, { command: bad }], "PreToolUse", {}, opts());
    expect(out.decision).toBeNull();
    expect(out.notices).toHaveLength(2);
    expect(out.notices[0]).toMatch(/timed out/);
    expect(out.notices[1]).toMatch(/exit 1/);
  });

  it("passes the payload on stdin and CLAUDE_PROJECT_DIR in the env", async () => {
    const s = script("echo.sh", 'printf "%s|%s" "$CLAUDE_PROJECT_DIR" "$(cat)"');
    const out = await runEvent([{ command: s }], "UserPromptSubmit", { prompt: "hi" }, opts());
    expect(out.context).toEqual([`${dir}|{"prompt":"hi"}`]);
  });
});

describe("session id", () => {
  it("prefers the override, then the persisted id, then the registry id", () => {
    const saved = [{ type: "custom", customType: SESSION_ENTRY, data: { id: "old-1" } }];
    expect(resolveSessionId({ PORCUPINE_CF_SESSION_ID: "parent", PORCUPINE_SESSION_ID: "x" }, saved, "pi")).toEqual({ id: "parent", persist: false });
    expect(resolveSessionId({ PORCUPINE_SESSION_ID: "x" }, saved, "pi")).toEqual({ id: "old-1", persist: false });
    expect(resolveSessionId({ PORCUPINE_SESSION_ID: "x" }, [], "pi")).toEqual({ id: "x", persist: true });
    expect(resolveSessionId({}, [], "pi")).toEqual({ id: "pi", persist: true });
  });
});

describe("bridge extension (smoke)", () => {
  it("blocks a tool call when a fixture PreToolUse hook exits 2", async () => {
    const log = join(dir, "seen.json");
    const s = script("guard.sh", `cat > ${log}; echo "blocked by cf" >&2; exit 2`);
    const pi = fakePi();
    claudeHooks(pi.api, { env: { PATH: process.env.PATH, PORCUPINE_SESSION_ID: "proj-123" }, settingsPath: settings({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: s }] }] }) });
    const c = ctx();
    await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, c);
    const r = await pi.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "t1", input: { command: "git push" } }, c);
    expect(r).toEqual({ block: true, reason: "blocked by cf" });
    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(log, "utf8"))).toMatchObject({
      session_id: "proj-123",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" },
      cwd: dir,
    });
    expect(pi.entries).toEqual([{ customType: SESSION_ENTRY, data: { id: "proj-123" } }]);
    const ok = await pi.handlers.get("tool_call")?.({ toolName: "read", toolCallId: "t2", input: { path: "x" } }, c);
    expect(ok).toBeUndefined();
  });

  it("routes ask to a confirm and blocks when declined", async () => {
    const s = script("ask.sh", `echo '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"sure?"}}'`);
    const pi = fakePi();
    claudeHooks(pi.api, { env: { PATH: process.env.PATH }, settingsPath: settings({ PreToolUse: [{ hooks: [{ command: s }] }] }) });
    expect(await pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx([], false))).toEqual({ block: true, reason: "sure?" });
    expect(await pi.handlers.get("tool_call")?.({ toolName: "bash", input: {} }, ctx([], true))).toBeUndefined();
  });

  it("injects UserPromptSubmit and SessionStart output as context, and drops blocked prompts", async () => {
    const start = script("start.sh", `echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"mode: yolo"}}'`);
    const prompt = script("prompt.sh", 'if grep -q secret; then echo "no secrets" >&2; exit 2; fi; echo "be brief"');
    const pi = fakePi();
    claudeHooks(pi.api, {
      env: { PATH: process.env.PATH },
      settingsPath: settings({ SessionStart: [{ hooks: [{ command: start }] }], UserPromptSubmit: [{ hooks: [{ command: prompt }] }] }),
    });
    const notices: string[] = [];
    const c = ctx(notices);
    await pi.handlers.get("session_start")?.({ reason: "startup" }, c);
    expect(await pi.handlers.get("input")?.({ text: "the secret", source: "rpc" }, c)).toEqual({ action: "handled" });
    expect(notices[0]).toMatch(/no secrets/);
    expect(await pi.handlers.get("input")?.({ text: "hello", source: "rpc" }, c)).toEqual({ action: "continue" });
    const r = (await pi.handlers.get("before_agent_start")?.({}, c)) as { message: { content: string } };
    expect(r.message.content).toBe("mode: yolo\n\nbe brief");
    expect(await pi.handlers.get("before_agent_start")?.({}, c)).toBeUndefined();
  });

  it("sends a Stop block reason as a follow-up at most three times in a row", async () => {
    const s = script("stop.sh", `echo '{"decision":"block","reason":"run the tests"}'`);
    const pi = fakePi();
    claudeHooks(pi.api, { env: { PATH: process.env.PATH }, settingsPath: settings({ Stop: [{ hooks: [{ command: s }] }] }) });
    for (let i = 0; i < MAX_STOP_BLOCKS + 1; i++) await pi.handlers.get("agent_end")?.({}, ctx());
    expect(pi.sent).toHaveLength(MAX_STOP_BLOCKS);
    expect(pi.sent[0]).toBe("run the tests");
  });

  it("appends PostToolUse block reasons to the tool result", async () => {
    const s = script("post.sh", 'echo "lint failed" >&2; exit 2');
    const pi = fakePi();
    claudeHooks(pi.api, { env: { PATH: process.env.PATH }, settingsPath: settings({ PostToolUse: [{ matcher: "Write", hooks: [{ command: s }] }] }) });
    const r = (await pi.handlers.get("tool_result")?.(
      { toolName: "write", input: { path: "a" }, content: [{ type: "text", text: "ok" }], isError: false },
      ctx(),
    )) as { content: { text: string }[] };
    expect(r.content).toHaveLength(2);
    expect(r.content[1]?.text).toMatch(/lint failed/);
  });
});
