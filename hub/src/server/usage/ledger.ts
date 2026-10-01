import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UsageRow {
  ts: string;
  sessionId: string;
  piSessionId: string | null;
  cwd: string;
  provider: string;
  model: string;
  responseId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Builds a ledger row from a pi assistant message, or null when it carries no usage.
 * `fallbackId` is used when the provider gave no responseId.
 */
export function rowFromMessage(
  message: unknown,
  ctx: { sessionId: string; piSessionId: string | null; cwd: string; fallbackId: string; ts?: string },
): UsageRow | null {
  if (!isRec(message) || message.role !== "assistant" || !isRec(message.usage)) return null;
  const u = message.usage;
  const cost = isRec(u.cost) ? num(u.cost.total) : 0;
  const ts =
    ctx.ts ?? (typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : new Date().toISOString());
  return {
    ts,
    sessionId: ctx.sessionId,
    piSessionId: ctx.piSessionId,
    cwd: ctx.cwd,
    provider: typeof message.provider === "string" ? message.provider : "unknown",
    model: typeof message.model === "string" ? message.model : "unknown",
    responseId: typeof message.responseId === "string" && message.responseId !== "" ? message.responseId : ctx.fallbackId,
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    reasoning: num(u.reasoning),
    costUsd: cost,
  };
}

function parseRow(line: string): UsageRow | null {
  try {
    const r = JSON.parse(line) as unknown;
    if (!isRec(r) || typeof r.responseId !== "string" || typeof r.provider !== "string" || typeof r.ts !== "string") return null;
    return r as unknown as UsageRow;
  } catch {
    return null;
  }
}

/** Local calendar month key, e.g. "2026-10". */
export function monthKey(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Local calendar day key, e.g. "2026-10-01". */
export function dayKey(d: Date): string {
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

function addTo(t: Totals, r: UsageRow): void {
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cacheWrite;
  t.costUsd += r.costUsd;
}

const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });

export interface ProviderSummary extends Totals {
  provider: string;
  models: (Totals & { model: string })[];
}

export interface UsageSummary {
  month: string;
  providers: ProviderSummary[];
  daily: { day: string; costUsd: number }[];
  sessions: Record<string, Totals>;
  allTime: Record<string, number>;
}

/** Append-only JSONL usage ledger with responseId dedupe. */
export class UsageLedger {
  private readonly rows: UsageRow[] = [];
  private readonly seen = new Set<string>();
  private needsNewline = false;

  constructor(private readonly file: string) {}

  /** Loads existing rows; skips malformed or truncated lines. */
  load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    this.needsNewline = text.length > 0 && !text.endsWith("\n");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const r = parseRow(line);
      if (r && !this.seen.has(r.responseId)) {
        this.seen.add(r.responseId);
        this.rows.push(r);
      }
    }
  }

  has(responseId: string): boolean {
    return this.seen.has(responseId);
  }

  /** Appends a row; false when its responseId was already recorded. */
  append(row: UsageRow): boolean {
    if (this.seen.has(row.responseId)) return false;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const prefix = this.needsNewline ? "\n" : "";
    appendFileSync(this.file, prefix + JSON.stringify(row) + "\n", { mode: 0o600 });
    this.needsNewline = false;
    this.seen.add(row.responseId);
    this.rows.push(row);
    return true;
  }

  all(): readonly UsageRow[] {
    return this.rows;
  }

  cwds(): Set<string> {
    return new Set(this.rows.map((r) => r.cwd));
  }

  /** Spend for one provider in the month containing `now` (local time). */
  monthSpend(provider: string, now: Date): number {
    const m = monthKey(now);
    return this.rows.filter((r) => r.provider === provider && monthKey(new Date(r.ts)) === m).reduce((s, r) => s + r.costUsd, 0);
  }

  allTimeSpend(provider: string): number {
    return this.rows.filter((r) => r.provider === provider).reduce((s, r) => s + r.costUsd, 0);
  }

  summary(now: Date, days = 30): UsageSummary {
    const month = monthKey(now);
    const providers = new Map<string, { t: Totals; models: Map<string, Totals> }>();
    const sessions: Record<string, Totals> = {};
    const allTime: Record<string, number> = {};
    const daily = new Map<string, number>();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    for (let i = 0; i < days; i++) daily.set(dayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)), 0);
    for (const r of this.rows) {
      const d = new Date(r.ts);
      allTime[r.provider] = (allTime[r.provider] ?? 0) + r.costUsd;
      addTo((sessions[r.sessionId] ??= zero()), r);
      const dk = dayKey(d);
      if (daily.has(dk)) daily.set(dk, (daily.get(dk) ?? 0) + r.costUsd);
      if (monthKey(d) !== month) continue;
      let p = providers.get(r.provider);
      if (!p) providers.set(r.provider, (p = { t: zero(), models: new Map() }));
      addTo(p.t, r);
      let m = p.models.get(r.model);
      if (!m) p.models.set(r.model, (m = zero()));
      addTo(m, r);
    }
    return {
      month,
      providers: [...providers.entries()]
        .map(([provider, p]) => ({
          provider,
          ...p.t,
          models: [...p.models.entries()].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.costUsd - a.costUsd),
        }))
        .sort((a, b) => b.costUsd - a.costUsd),
      daily: [...daily.entries()].map(([day, costUsd]) => ({ day, costUsd })),
      sessions,
      allTime,
    };
  }
}
