/**
 * Session sheet picker for the cf merge mode. The hub reads and writes it
 * through cf's own scripts; the shown default is whatever cf falls back to.
 */
import { el } from "./render.js";

export interface MergeModeState {
  mode: string;
  stored: string | null;
  fallback: string;
  modes: string[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const LABELS: Record<string, string> = {
  "local-only": "Local only",
  "merge-ready": "Merge ready",
  "admin-bypass": "Admin bypass",
  yolo: "Yolo",
};

export function modeLabel(slug: string): string {
  return LABELS[slug] ?? slug;
}

export function parseState(v: unknown): MergeModeState | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.mode !== "string" || typeof o.fallback !== "string" || !Array.isArray(o.modes)) return null;
  return {
    mode: o.mode,
    stored: typeof o.stored === "string" ? o.stored : null,
    fallback: o.fallback,
    modes: o.modes.filter((m): m is string => typeof m === "string"),
  };
}

function errorOf(v: unknown): string {
  return v && typeof v === "object" && typeof (v as { error?: unknown }).error === "string" ? (v as { error: string }).error : "unavailable";
}

export class MergeModePicker {
  private sessionId: string | null = null;
  private seq = 0;

  constructor(
    private readonly select: HTMLSelectElement,
    private readonly status: HTMLElement,
    private readonly fetcher: FetchLike = (u, i) => fetch(u, { credentials: "same-origin", ...i }),
  ) {
    select.addEventListener("change", () => void this.save(select.value));
  }

  render(state: MergeModeState | null, message: string): void {
    this.select.replaceChildren();
    if (state) {
      for (const m of state.modes) {
        const label = m === state.fallback ? `${modeLabel(m)} (cf default)` : modeLabel(m);
        this.select.append(el("option", { value: m }, label));
      }
      this.select.value = state.mode;
    }
    this.select.disabled = state === null;
    this.status.textContent = message;
  }

  async load(sessionId: string | null): Promise<void> {
    this.sessionId = sessionId;
    const seq = ++this.seq;
    if (!sessionId) {
      this.render(null, "No session");
      return;
    }
    try {
      const r = await this.fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/merge-mode`);
      const body = await r.json();
      if (seq !== this.seq) return;
      const st = r.ok ? parseState(body) : null;
      this.render(st, st ? describe(st) : `Merge mode ${errorOf(body)}`);
    } catch {
      if (seq === this.seq) this.render(null, "Merge mode unavailable");
    }
  }

  async save(mode: string): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    const seq = ++this.seq;
    this.select.disabled = true;
    try {
      const r = await this.fetcher(`/api/sessions/${encodeURIComponent(sid)}/merge-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const body = await r.json();
      if (seq !== this.seq) return;
      const st = r.ok ? parseState(body) : null;
      if (st) this.render(st, `Saved. ${describe(st)}`);
      else {
        this.select.disabled = false;
        this.status.textContent = `Save failed: ${errorOf(body)}`;
      }
    } catch {
      if (seq === this.seq) {
        this.select.disabled = false;
        this.status.textContent = "Save failed";
      }
    }
  }
}

export function describe(st: MergeModeState): string {
  return st.stored ? `${modeLabel(st.mode)} for this session.` : `Not set; cf falls back to ${modeLabel(st.fallback)}.`;
}
