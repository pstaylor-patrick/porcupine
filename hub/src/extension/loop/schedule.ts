/** Pure helpers for the loop extension: interval parsing and persisted state. */

export const ENTRY_TYPE = "porcupine_loop";
export const STATUS_KEY = "loop";
/** Self-paced loops that never call schedule_next wait this long. */
export const DEFAULT_SELF_PACED_SEC = 600;
export const MIN_DELAY_SEC = 5;
export const MAX_DELAY_SEC = 7 * 24 * 3600;

export interface LoopState {
  prompt: string;
  /** Fixed interval in seconds, or null when the model paces itself. */
  intervalSec: number | null;
  /** Epoch ms of the next tick, or null while waiting for schedule_next. */
  nextAt: number | null;
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Parses "30s", "5m", "1h", "2d"; bare numbers are seconds. */
export function parseInterval(text: string): number | undefined {
  const m = /^(\d+)([smhd]?)$/i.exec(text.trim());
  if (!m?.[1]) return undefined;
  const sec = Number(m[1]) * (UNITS[(m[2] ?? "").toLowerCase() || "s"] ?? 1);
  return sec >= MIN_DELAY_SEC && sec <= MAX_DELAY_SEC ? sec : undefined;
}

export function clampDelay(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_SELF_PACED_SEC;
  return Math.min(MAX_DELAY_SEC, Math.max(MIN_DELAY_SEC, Math.round(sec)));
}

export type LoopCommand = { kind: "stop" } | { kind: "status" } | { kind: "start"; prompt: string; intervalSec: number | null } | { kind: "error" };

export function parseLoopArgs(args: string): LoopCommand {
  const text = args.trim();
  if (text === "") return { kind: "status" };
  if (text === "stop") return { kind: "stop" };
  const [first = "", ...rest] = text.split(/\s+/);
  const interval = parseInterval(first);
  if (interval !== undefined) {
    const prompt = rest.join(" ").trim();
    return prompt === "" ? { kind: "error" } : { kind: "start", prompt, intervalSec: interval };
  }
  return { kind: "start", prompt: text, intervalSec: null };
}

export function formatDelay(sec: number): string {
  if (sec % 3600 === 0) return `${String(sec / 3600)}h`;
  if (sec % 60 === 0) return `${String(sec / 60)}m`;
  return `${String(sec)}s`;
}

export function statusText(state: LoopState, now: number): string {
  const pace = state.intervalSec === null ? "self-paced" : `every ${formatDelay(state.intervalSec)}`;
  if (state.nextAt === null) return `loop ${pace}: waiting for schedule_next`;
  const left = Math.max(0, Math.round((state.nextAt - now) / 1000));
  return `loop ${pace}: next in ${formatDelay(left)}`;
}

export function isLoopState(v: unknown): v is LoopState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s["prompt"] === "string" &&
    s["prompt"] !== "" &&
    (s["intervalSec"] === null || typeof s["intervalSec"] === "number") &&
    (s["nextAt"] === null || typeof s["nextAt"] === "number")
  );
}
