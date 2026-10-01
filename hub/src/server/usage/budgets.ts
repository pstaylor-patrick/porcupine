import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type BudgetKind = "monthly" | "balance";
export interface Budget {
  kind: BudgetKind;
  amountUsd: number;
}
export type Budgets = Record<string, Budget>;

export class BudgetError extends Error {}

const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_PROVIDERS = 32;

/** Validates a budgets.json value; throws BudgetError with a readable reason. */
export function validateBudgets(v: unknown): Budgets {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new BudgetError("expected an object keyed by provider");
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_PROVIDERS) throw new BudgetError(`at most ${String(MAX_PROVIDERS)} providers`);
  const out: Budgets = {};
  for (const [provider, b] of entries) {
    if (!PROVIDER_RE.test(provider)) throw new BudgetError(`invalid provider name: ${provider}`);
    if (typeof b !== "object" || b === null) throw new BudgetError(`${provider}: expected { kind, amountUsd }`);
    const { kind, amountUsd } = b as Record<string, unknown>;
    if (kind !== "monthly" && kind !== "balance") throw new BudgetError(`${provider}: kind must be monthly or balance`);
    if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 1_000_000) {
      throw new BudgetError(`${provider}: amountUsd must be a positive number`);
    }
    out[provider] = { kind, amountUsd };
  }
  return out;
}

export function loadBudgets(file: string, log: (l: string) => void = () => undefined): Budgets {
  try {
    return validateBudgets(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`budgets: ignoring ${file}: ${(e as Error).message}`);
    return {};
  }
}

/** Writes JSON atomically via temp file plus rename. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

export interface BudgetStatus {
  provider: string;
  kind: BudgetKind;
  amountUsd: number;
  spentUsd: number;
  pct: number;
  live: boolean;
}

export type Threshold = 80 | 100;
export const THRESHOLDS: readonly Threshold[] = [80, 100];

/** Period key for warning dedupe: the month for monthly budgets, the amount for balances. */
export function periodKey(s: BudgetStatus, month: string): string {
  return s.kind === "monthly" ? `${s.provider}:monthly:${month}` : `${s.provider}:balance:${String(s.amountUsd)}`;
}

/** Returns thresholds newly crossed and updates `state` (period key -> thresholds already warned). */
export function newCrossings(
  statuses: BudgetStatus[],
  state: Record<string, number[]>,
  month: string,
): { status: BudgetStatus; threshold: Threshold }[] {
  const out: { status: BudgetStatus; threshold: Threshold }[] = [];
  for (const s of statuses) {
    const key = periodKey(s, month);
    const done = new Set(state[key] ?? []);
    const crossed = THRESHOLDS.filter((t) => s.pct >= t && !done.has(t));
    if (crossed.length === 0) continue;
    const top = crossed[crossed.length - 1] as Threshold;
    for (const t of crossed) done.add(t);
    state[key] = [...done].sort((a, b) => a - b);
    out.push({ status: s, threshold: top });
  }
  return out;
}
