import { isAbsolute, join } from "node:path";

export interface UsageConfig {
  /** Directory holding usage.jsonl, budgets.json, budget-state.json and backfill.done. */
  dir: string;
  /** pi's session store, walked once by the backfill. */
  piSessionsDir: string;
  /** OpenRouter key for the live balance; null disables the lookup. */
  openrouterKey: string | null;
}

/** Resolves the data dir exactly like uploads/config.ts: ${XDG_DATA_HOME:-~/.local/share}/porcupine. */
export function usageConfig(env: NodeJS.ProcessEnv, home: string): UsageConfig {
  const dataHome = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share");
  return {
    dir: join(dataHome, "porcupine"),
    piSessionsDir: join(home, ".pi", "agent", "sessions"),
    openrouterKey: env.OPENROUTER_API_KEY?.trim() || null,
  };
}
