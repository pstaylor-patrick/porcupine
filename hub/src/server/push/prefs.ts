import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Which events send a push. Shared by every device. */
export interface NotifyPrefs {
  input: boolean;
  finished: boolean;
  budget: boolean;
}

export const DEFAULT_PREFS: NotifyPrefs = { input: true, finished: false, budget: true };
const KEYS = Object.keys(DEFAULT_PREFS) as (keyof NotifyPrefs)[];

/** Keeps known boolean keys from `v`, defaults for the rest. */
export function parsePrefs(v: unknown): NotifyPrefs {
  const out = { ...DEFAULT_PREFS };
  if (v && typeof v === "object") {
    for (const k of KEYS) {
      const b = (v as Record<string, unknown>)[k];
      if (typeof b === "boolean") out[k] = b;
    }
  }
  return out;
}

/** push-prefs.json, written atomically. */
export class PrefsStore {
  private prefs: NotifyPrefs;

  constructor(private readonly file: string) {
    let raw: unknown = null;
    try {
      if (existsSync(file)) raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      raw = null;
    }
    this.prefs = parsePrefs(raw);
  }

  get(): NotifyPrefs {
    return { ...this.prefs };
  }

  set(v: unknown): NotifyPrefs {
    this.prefs = parsePrefs({ ...this.prefs, ...(v && typeof v === "object" ? v : {}) });
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.prefs, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    return this.get();
  }
}
