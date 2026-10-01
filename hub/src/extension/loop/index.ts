/**
 * Pi extension: recurring prompts.
 *
 * `/loop <interval> <prompt>` sends the prompt every interval; `/loop <prompt>`
 * lets the model pace itself with the schedule_next tool; `/loop stop` or the
 * stop_loop tool ends it. A tick sends the prompt straight away when the agent
 * is idle and queues it as a follow-up otherwise. State is persisted with
 * appendEntry and re-armed on session start, shown via setStatus, and lives
 * in-process, so the loop dies with the pane. Prompts run inside this session,
 * so the claude-hooks bridge applies the session's cf merge mode to them.
 *
 * Carries its own minimal types; pi resolves nothing from this file.
 */
import {
  clampDelay,
  DEFAULT_SELF_PACED_SEC,
  ENTRY_TYPE,
  formatDelay,
  isLoopState,
  type LoopState,
  parseLoopArgs,
  STATUS_KEY,
  statusText,
} from "./schedule.js";

interface Entry {
  type: string;
  customType?: string;
  data?: unknown;
}
export interface Ctx {
  hasUI?: boolean;
  ui?: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus?(key: string, text: string | undefined): void;
  };
  isIdle(): boolean;
  sessionManager?: { getEntries(): Entry[] };
}
interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}
export interface Api {
  on(event: "session_start" | "agent_end" | "agent_start" | "session_shutdown", handler: (event: unknown, ctx: Ctx) => void): unknown;
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: Ctx): Promise<ToolResult>;
  }): void;
  appendEntry(customType: string, data?: unknown): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

function restore(ctx: Ctx): LoopState | null {
  const entries = ctx.sessionManager?.getEntries() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== "custom" || e.customType !== ENTRY_TYPE) continue;
    const v = (e.data as { state?: unknown } | undefined)?.state;
    return isLoopState(v) ? v : null;
  }
  return null;
}

const text = (t: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text: t }], details });

export default function loop(pi: Api, clock: Clock = realClock): void {
  let state: LoopState | null = null;
  let timer: unknown = null;
  let ctxRef: Ctx | null = null;
  /** Whether the model called schedule_next during the current run. */
  let scheduledThisRun = false;

  const notify = (msg: string, level: "info" | "error" = "info"): void => {
    if (ctxRef?.hasUI) ctxRef.ui?.notify(msg, level);
  };
  const showStatus = (): void => {
    ctxRef?.ui?.setStatus?.(STATUS_KEY, state ? statusText(state, clock.now()) : undefined);
  };
  const persist = (): void => {
    pi.appendEntry(ENTRY_TYPE, { state });
  };
  const disarm = (): void => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    disarm();
    if (!state || state.nextAt === null) return;
    timer = clock.setTimeout(tick, Math.max(0, state.nextAt - clock.now()));
  };
  const scheduleIn = (sec: number): void => {
    if (!state) return;
    state = { ...state, nextAt: clock.now() + sec * 1000 };
    persist();
    arm();
    showStatus();
  };
  const tick = (): void => {
    timer = null;
    if (!state) return;
    const { prompt, intervalSec } = state;
    if (intervalSec !== null) {
      state = { ...state, nextAt: clock.now() + intervalSec * 1000 };
      arm();
    } else {
      state = { ...state, nextAt: null };
    }
    persist();
    showStatus();
    if (ctxRef === null || ctxRef.isIdle()) pi.sendUserMessage(prompt);
    else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  };
  const stop = (): void => {
    disarm();
    state = null;
    persist();
    showStatus();
  };

  pi.on("session_start", (_e, ctx) => {
    ctxRef = ctx;
    disarm();
    state = restore(ctx);
    if (state && state.nextAt === null) state = { ...state, nextAt: clock.now() + DEFAULT_SELF_PACED_SEC * 1000 };
    arm();
    showStatus();
  });
  pi.on("agent_start", (_e, ctx) => {
    ctxRef = ctx;
    scheduledThisRun = false;
  });
  pi.on("agent_end", (_e, ctx) => {
    ctxRef = ctx;
    // A self-paced run that ended without schedule_next falls back to a default delay.
    if (state && state.intervalSec === null && state.nextAt === null && !scheduledThisRun) scheduleIn(DEFAULT_SELF_PACED_SEC);
  });
  pi.on("session_shutdown", () => {
    disarm();
  });

  pi.registerCommand("loop", {
    description: "Repeat a prompt: /loop <interval> <prompt>, /loop <prompt> (self-paced), /loop stop",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const cmd = parseLoopArgs(args);
      if (cmd.kind === "error") {
        notify("usage: /loop <interval> <prompt> | /loop <prompt> | /loop stop", "error");
        return;
      }
      if (cmd.kind === "status") {
        notify(state ? statusText(state, clock.now()) : "no loop running");
        return;
      }
      if (cmd.kind === "stop") {
        notify(state ? "loop stopped" : "no loop running");
        if (state) stop();
        return;
      }
      state = { prompt: cmd.prompt, intervalSec: cmd.intervalSec, nextAt: null };
      notify(cmd.intervalSec === null ? "loop started, self-paced" : `loop started, every ${formatDelay(cmd.intervalSec)}`);
      // First tick runs now; fixed loops re-arm inside tick, self-paced wait for schedule_next.
      tick();
    },
  });

  pi.registerTool({
    name: "schedule_next",
    label: "Schedule next loop tick",
    description:
      "While a self-paced /loop is active, choose when the loop prompt runs next. Call once per run with a delay in seconds (5 to 604800) and a short reason.",
    parameters: {
      type: "object",
      required: ["delaySec"],
      additionalProperties: false,
      properties: { delaySec: { type: "number", description: "Seconds until the next tick" }, reason: { type: "string" } },
    },
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      ctxRef = ctx;
      if (!state) return text("No loop is active; nothing scheduled.");
      const sec = clampDelay(Number(params["delaySec"]));
      scheduledThisRun = true;
      scheduleIn(sec);
      return text(`Next loop tick in ${formatDelay(sec)}.`, { delaySec: sec, reason: params["reason"] ?? null });
    },
  });
  pi.registerTool({
    name: "stop_loop",
    label: "Stop loop",
    description: "Stop the active /loop when its goal is met or it should not continue. Give a short reason.",
    parameters: { type: "object", additionalProperties: false, properties: { reason: { type: "string" } } },
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      ctxRef = ctx;
      if (!state) return text("No loop is active.");
      stop();
      notify(`loop stopped: ${typeof params["reason"] === "string" ? params["reason"] : "by the agent"}`);
      return text("Loop stopped.");
    },
  });
}
