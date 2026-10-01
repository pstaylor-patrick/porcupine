export interface OpenRouterKey {
  limit: number | null;
  limitRemaining: number | null;
  usage: number | null;
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

const URL_KEY = "https://openrouter.ai/api/v1/key";
export const CACHE_MS = 5 * 60 * 1000;

function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parses GET /api/v1/key: { data: { limit, limit_remaining, usage, ... } }. */
export function parseKeyResponse(body: unknown): OpenRouterKey | null {
  if (typeof body !== "object" || body === null) return null;
  const d = (body as { data?: unknown }).data;
  if (typeof d !== "object" || d === null) return null;
  const r = d as Record<string, unknown>;
  return { limit: n(r.limit), limitRemaining: n(r.limit_remaining), usage: n(r.usage) };
}

/** Live OpenRouter key balance, cached for five minutes; null on any failure. */
export class OpenRouterBalance {
  private cached: { at: number; value: OpenRouterKey | null } | null = null;
  private inflight: Promise<OpenRouterKey | null> | null = null;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly key: string | null,
    private readonly now: () => number,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? (fetch as unknown as FetchLike);
  }

  peek(): OpenRouterKey | null {
    return this.cached?.value ?? null;
  }

  async get(): Promise<OpenRouterKey | null> {
    if (!this.key) return null;
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached.value;
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async load(): Promise<OpenRouterKey | null> {
    let value: OpenRouterKey | null = null;
    try {
      const r = await this.fetchImpl(URL_KEY, {
        headers: { Authorization: `Bearer ${this.key ?? ""}` },
        signal: AbortSignal.timeout(10_000),
      });
      value = r.ok ? parseKeyResponse(await r.json()) : null;
    } catch {
      value = null;
    }
    this.cached = { at: this.now(), value };
    return value;
  }
}
