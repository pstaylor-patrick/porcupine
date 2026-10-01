/** Context meter helpers: parse get_session_stats and format the display. */

export interface ContextInfo {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseContextUsage(stats: unknown): ContextInfo | null {
  if (!isRec(stats) || !isRec(stats.contextUsage)) return null;
  const u = stats.contextUsage;
  if (typeof u.contextWindow !== "number") return null;
  return {
    tokens: typeof u.tokens === "number" ? u.tokens : null,
    contextWindow: u.contextWindow,
    percent: typeof u.percent === "number" ? u.percent : null,
  };
}

export function contextText(c: ContextInfo | null): string {
  if (!c || c.tokens === null) return c ? `unknown / ${c.contextWindow.toLocaleString("en-US")} tokens` : "unknown";
  return `${c.tokens.toLocaleString("en-US")} / ${c.contextWindow.toLocaleString("en-US")} tokens`;
}

export function contextPercent(c: ContextInfo | null): string | null {
  return c && c.percent !== null ? `${String(Math.round(c.percent))}%` : null;
}

/** The /autocompact command for the sheet's field; null when the value is invalid. */
/** The hub's default auto-compact point: 250,000 tokens, or 80% of a smaller window. */
export function defaultThreshold(contextWindow: number | undefined): number {
  const tokens = 250_000;
  return contextWindow && contextWindow <= tokens ? Math.floor(contextWindow * 0.8) : tokens;
}

export function autocompactCommand(raw: string, off: boolean): string | null {
  if (off) return "/autocompact off";
  const v = raw.replace(/[,\s]/g, "");
  if (v === "") return "/autocompact default";
  return /^\d+$/.test(v) && Number(v) > 0 ? `/autocompact ${v}` : null;
}

/** Groups the digits of a token count with commas as it is typed; other characters are dropped. */
export function groupDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
