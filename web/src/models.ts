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

export type Capability = "thinking" | "images" | "long" | "cheap";

export const CAPABILITIES: readonly { key: Capability; label: string }[] = [
  { key: "thinking", label: "Thinking" },
  { key: "images", label: "Images" },
  { key: "long", label: "Long context" },
  { key: "cheap", label: "Cheap" },
];

/** Tokens, inclusive. */
export const LONG_CONTEXT_MIN = 400_000;
/** Dollars per million input tokens, inclusive. A missing or zero price is unknown, not cheap. */
export const CHEAP_INPUT_MAX = 0.5;

export function hasCapability(m: ModelInfo, c: Capability): boolean {
  switch (c) {
    case "thinking":
      return m.reasoning === true;
    case "images":
      return m.input?.includes("image") === true;
    case "long":
      return (m.contextWindow ?? 0) >= LONG_CONTEXT_MIN;
    case "cheap": {
      const i = m.cost?.input;
      return i !== undefined && i > 0 && i <= CHEAP_INPUT_MAX;
    }
  }
}

/** Keeps models that have every selected capability and match every query term. */
export function filterModels(models: ModelInfo[], query: string, caps: ReadonlySet<Capability> = new Set()): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (!q && caps.size === 0) return models;
  const terms = q ? q.split(/\s+/) : [];
  return models.filter((m) => {
    for (const c of caps) if (!hasCapability(m, c)) return false;
    if (terms.length === 0) return true;
    const words = [`${m.provider}/${m.id}`, m.name ?? ""];
    if (hasCapability(m, "thinking")) words.push("thinking");
    if (hasCapability(m, "images")) words.push("images");
    const hay = words.join(" ").toLowerCase();
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

/** Vendor is the id prefix before "/"; ids without one fall back to the provider. */
export function vendorOf(id: string, provider = "other"): string {
  const i = id.indexOf("/");
  return i > 0 ? id.slice(0, i) : provider;
}

function trim(n: number, digits: number): string {
  return String(Number(n.toFixed(digits)));
}

/** "1M ctx" at or above a million tokens, otherwise "NK ctx"; null when unknown. */
export function formatContext(n: number | undefined): string | null {
  if (n === undefined || n <= 0) return null;
  if (n >= 1_000_000) return `${trim(n / 1_000_000, 1)}M ctx`;
  return `${trim(n / 1000, 0)}K ctx`;
}

/** "$3/$15 per M"; null when cost is missing or both values are zero. */
export function formatPrice(cost: ModelCost | undefined): string | null {
  if (!cost || cost.input === undefined || cost.output === undefined) return null;
  if (cost.input === 0 && cost.output === 0) return null;
  return `$${trim(cost.input, 2)}/$${trim(cost.output, 2)} per M`;
}

/** One secondary line: context, thinking, images, price; missing parts are left out. */
export function rowDetail(m: ModelInfo): string {
  const parts: string[] = [];
  const ctx = formatContext(m.contextWindow);
  if (ctx) parts.push(ctx);
  if (m.reasoning) parts.push("thinking");
  if (m.input?.includes("image")) parts.push("images");
  const price = formatPrice(m.cost);
  if (price) parts.push(price);
  return parts.join(" - ");
}

export interface VendorGroup {
  vendor: string;
  models: ModelInfo[];
  count: number;
}

/** Groups models by vendor, sorted by vendor name; model order within a group is kept. */
export function groupByVendor(models: readonly ModelInfo[]): VendorGroup[] {
  const byVendor = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const v = vendorOf(m.id, m.provider);
    const list = byVendor.get(v);
    if (list) list.push(m);
    else byVendor.set(v, [m]);
  }
  return [...byVendor.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vendor, list]) => ({ vendor, models: list, count: list.length }));
}

export const RECENT_KEY = "porcupine.recentModels";
export const RECENT_SEED = "anthropic/claude-opus-5.5";
export const RECENT_MAX = 8;

export type RecentStorage = Pick<Storage, "getItem" | "setItem">;

/** Recently used model ids, most recent first; the seed when storage is empty, broken or unavailable. */
export function loadRecent(storage: RecentStorage | null | undefined): string[] {
  try {
    const raw = storage?.getItem(RECENT_KEY);
    if (!raw) return [RECENT_SEED];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [RECENT_SEED];
    const ids = parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
    return ids.length > 0 ? [...new Set(ids)].slice(0, RECENT_MAX) : [RECENT_SEED];
  } catch {
    return [RECENT_SEED];
  }
}

/** Recents key: provider, "|", id. Model ids contain "/", provider ids never contain "|". */
export function recentKey(m: Pick<ModelInfo, "provider" | "id">): string {
  return `${m.provider}|${m.id}`;
}

function findRecent(key: string, models: readonly ModelInfo[], currentProvider: string | undefined): ModelInfo | undefined {
  const bar = key.indexOf("|");
  if (bar >= 0) {
    const provider = key.slice(0, bar);
    const id = key.slice(bar + 1);
    return models.find((m) => m.provider === provider && m.id === id);
  }
  // Old id-only entry: prefer the current provider, else the first model with that id.
  return models.find((m) => m.id === key && m.provider === currentProvider) ?? models.find((m) => m.id === key);
}

/** Resolves stored keys, old id-only or provider|id, to models; unknown keys are dropped and duplicates removed. */
export function resolveRecent(keys: readonly string[], models: readonly ModelInfo[], currentProvider?: string): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const k of keys) {
    const m = findRecent(k, models, currentProvider);
    if (!m) continue;
    const nk = recentKey(m);
    if (seen.has(nk)) continue;
    seen.add(nk);
    out.push(m);
  }
  return out;
}

/** Rewrites old id-only keys that resolve against `models` in provider|id form and dedupes; unresolved keys are kept as they are. */
export function migrateRecent(keys: readonly string[], models: readonly ModelInfo[], currentProvider?: string): string[] {
  const out = keys.map((k) => {
    if (k.includes("|")) return k;
    const m = findRecent(k, models, currentProvider);
    return m ? recentKey(m) : k;
  });
  return [...new Set(out)];
}

/** Moves `key` to the front, dedupes, caps at RECENT_MAX and saves; storage errors are ignored. */
export function pushRecent(
  storage: RecentStorage | null | undefined,
  key: string,
  models: readonly ModelInfo[] = [],
  currentProvider?: string,
): string[] {
  const prev = migrateRecent(loadRecent(storage), models, currentProvider);
  const next = [key, ...prev.filter((k) => k !== key)].slice(0, RECENT_MAX);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode or quota: keep going without persistence.
  }
  return next;
}
