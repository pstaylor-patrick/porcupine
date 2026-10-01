/**
 * Pi extension: compact at a configurable token threshold.
 *
 * Modelled on pi's examples/extensions/trigger-compact.ts. The threshold is
 * PORCUPINE_AUTOCOMPACT_TOKENS (default 250000); when the model's context
 * window is at or below it, compaction triggers at
 * PORCUPINE_AUTOCOMPACT_FALLBACK_PCT (default 80) percent of the window.
 * `/autocompact <tokens|off|default>` sets a per-session override, persisted
 * with appendEntry and restored on session start. Pi's own overflow
 * compaction stays on as the safety net.
 *
 * Carries its own minimal types; pi resolves nothing from this file.
 */
import { configFromEnv, describe, effectiveThreshold, ENTRY_TYPE, parseOverride, type Override } from "./threshold.js";

interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
interface Entry {
  type: string;
  customType?: string;
  data?: unknown;
}
export interface Ctx {
  hasUI?: boolean;
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
  getContextUsage(): ContextUsage | undefined;
  compact(options?: { onComplete?: () => void; onError?: (e: Error) => void }): void;
  sessionManager?: { getEntries(): Entry[] };
}
export interface Api {
  on(event: "turn_end" | "session_start" | "agent_start", handler: (event: unknown, ctx: Ctx) => void): unknown;
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
  appendEntry(customType: string, data?: unknown): void;
}

function restore(ctx: Ctx): Override {
  const entries = ctx.sessionManager?.getEntries() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== "custom" || e.customType !== ENTRY_TYPE) continue;
    const v = (e.data as { value?: unknown } | undefined)?.value;
    if (v === "off" || v === null) return v;
    if (typeof v === "number" && v > 0) return v;
    return null;
  }
  return null;
}

export default function autocompact(pi: Api, env: Record<string, string | undefined> = process.env): void {
  const cfg = configFromEnv(env);
  let override: Override = null;
  let compacting = false;
  let firedThisRun = false;

  const notify = (ctx: Ctx, msg: string, level: "info" | "error" = "info"): void => {
    if (ctx.hasUI) ctx.ui?.notify(msg, level);
  };

  pi.on("session_start", (_e, ctx) => {
    override = restore(ctx);
  });
  pi.on("agent_start", () => {
    firedThisRun = false;
  });
  pi.on("turn_end", (_e, ctx) => {
    if (compacting || firedThisRun) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;
    const at = effectiveThreshold(usage.contextWindow, cfg, override);
    if (at === null || usage.tokens < at) return;
    compacting = true;
    firedThisRun = true;
    notify(ctx, `auto-compact: ${String(usage.tokens)} tokens >= ${String(at)}`);
    ctx.compact({
      onComplete: () => {
        compacting = false;
      },
      onError: (e) => {
        compacting = false;
        notify(ctx, `auto-compact failed: ${e.message}`, "error");
      },
    });
  });

  pi.registerCommand("autocompact", {
    description: "Auto-compact threshold for this session: <tokens|off|default>",
    handler: async (args, ctx) => {
      const window = ctx.getContextUsage()?.contextWindow ?? null;
      if (args.trim() !== "") {
        const v = parseOverride(args);
        if (v === undefined) {
          notify(ctx, "usage: /autocompact <tokens|off|default>", "error");
          return;
        }
        override = v;
        pi.appendEntry(ENTRY_TYPE, { value: v });
      }
      notify(ctx, describe(window, cfg, override));
    },
  });
}
