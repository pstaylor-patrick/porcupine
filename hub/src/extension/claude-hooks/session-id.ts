/**
 * The session_id cf sees. PORCUPINE_CF_SESSION_ID (set for subagents and
 * loops) wins and is never persisted. Otherwise the id persisted in the pi
 * session is reused so `--continue` keeps the merge mode, else the porcupine
 * registry id (PORCUPINE_SESSION_ID), else pi's own session id.
 */
export const SESSION_ENTRY = "porcupine_cf_session";

interface Entry {
  type: string;
  customType?: string;
  data?: unknown;
}

export interface ResolvedId {
  id: string;
  /** True when the id should be appended to the session for later restores. */
  persist: boolean;
}

export function persistedId(entries: Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== "custom" || e.customType !== SESSION_ENTRY) continue;
    const id = (e.data as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

export function resolveSessionId(env: Record<string, string | undefined>, entries: Entry[], piSessionId: string | null): ResolvedId {
  const forced = env.PORCUPINE_CF_SESSION_ID?.trim();
  if (forced) return { id: forced, persist: false };
  const saved = persistedId(entries);
  if (saved) return { id: saved, persist: false };
  const fresh = env.PORCUPINE_SESSION_ID?.trim() || piSessionId || `porcupine-${String(process.pid)}`;
  return { id: fresh, persist: true };
}
