/** Pure threshold math for the autocompact extension. */

export const DEFAULT_TOKENS = 250_000;
export const DEFAULT_FALLBACK_PCT = 80;
export const ENTRY_TYPE = "porcupine_autocompact";

/** A per-session override: a token count, "off", or null for the env default. */
export type Override = number | "off" | null;

export interface EnvConfig {
  tokens: number | "off";
  fallbackPct: number;
}

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

export function configFromEnv(env: Record<string, string | undefined>): EnvConfig {
  const rawTokens = env.PORCUPINE_AUTOCOMPACT_TOKENS?.trim().toLowerCase();
  const tokens = rawTokens === "off" ? "off" : (positiveInt(rawTokens) ?? DEFAULT_TOKENS);
  const pct = positiveInt(env.PORCUPINE_AUTOCOMPACT_FALLBACK_PCT);
  return { tokens, fallbackPct: pct !== null && pct <= 100 ? pct : DEFAULT_FALLBACK_PCT };
}

/** Parses the /autocompact argument; undefined means invalid. */
export function parseOverride(arg: string): Override | undefined {
  const a = arg.trim().toLowerCase();
  if (a === "off") return "off";
  if (a === "default" || a === "") return null;
  return positiveInt(a.replace(/[_,]/g, "")) ?? undefined;
}

/** Token count at which to compact, or null when auto-compact is off. */
export function effectiveThreshold(contextWindow: number, cfg: EnvConfig, override: Override): number | null {
  const threshold = override ?? cfg.tokens;
  if (threshold === "off") return null;
  if (contextWindow > 0 && contextWindow <= threshold) return Math.floor((contextWindow * cfg.fallbackPct) / 100);
  return threshold;
}

export function describe(contextWindow: number | null, cfg: EnvConfig, override: Override): string {
  const source = override === null ? "default" : "session override";
  if ((override ?? cfg.tokens) === "off") return `auto-compact off (${source})`;
  if (contextWindow === null) return `auto-compact at ${String(override ?? cfg.tokens)} tokens (${source})`;
  const t = effectiveThreshold(contextWindow, cfg, override);
  return `auto-compact at ${String(t)} of ${String(contextWindow)} tokens (${source})`;
}
