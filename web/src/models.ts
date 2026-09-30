/** Pure model-list logic for the session settings sheet. */

export interface ModelCost {
  input?: number;
  output?: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  input?: string[];
  cost?: ModelCost;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Keeps the fields the sheet uses from a pi Model; null when id or provider is missing. */
export function parseModel(raw: unknown): ModelInfo | null {
  if (!isRec(raw) || typeof raw.id !== "string" || typeof raw.provider !== "string") return null;
  const m: ModelInfo = { id: raw.id, provider: raw.provider };
  if (typeof raw.name === "string") m.name = raw.name;
  if (typeof raw.reasoning === "boolean") m.reasoning = raw.reasoning;
  const ctx = num(raw.contextWindow);
  if (ctx !== undefined) m.contextWindow = ctx;
  if (Array.isArray(raw.input)) m.input = raw.input.filter((x): x is string => typeof x === "string");
  if (isRec(raw.cost)) {
    const cost: ModelCost = {};
    const i = num(raw.cost.input);
    const o = num(raw.cost.output);
    if (i !== undefined) cost.input = i;
    if (o !== undefined) cost.output = o;
    m.cost = cost;
  }
  return m;
}

export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  const terms = q.split(/\s+/);
  return models.filter((m) => {
    const hay = `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export type SheetState = "detached" | "loading" | "error" | "empty" | "ready";

export function sheetState(s: { attached: boolean; loading: boolean; error: string | null; models: readonly ModelInfo[] }): SheetState {
  if (!s.attached) return "detached";
  if (s.loading) return "loading";
  if (s.error !== null) return "error";
  return s.models.length === 0 ? "empty" : "ready";
}
