import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backfill } from "./backfill.js";
import { loadBudgets, newCrossings, writeJsonAtomic, type BudgetStatus, type Budgets, type Threshold } from "./budgets.js";
import type { UsageConfig } from "./config.js";
import { monthKey, rowFromMessage, UsageLedger, type UsageSummary } from "./ledger.js";
import { OpenRouterBalance, type FetchLike, type OpenRouterKey } from "./openrouter.js";

export interface BudgetWarning {
  provider: string;
  threshold: Threshold;
  status: BudgetStatus;
  text: string;
}

export interface UsageServiceOptions {
  config: UsageConfig;
  now?: () => number;
  log?: (l: string) => void;
  fetch?: FetchLike | undefined;
  /** Called once per threshold per period. Phase 5 hooks push notifications here. */
  onBudgetWarning?: (w: BudgetWarning) => void;
}

export interface UsageReport extends UsageSummary {
  budgets: Budgets;
  status: BudgetStatus[];
  openrouter: OpenRouterKey | null;
  openrouterConfigured: boolean;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Ledger, budgets and warning state for the hub. Warn only: nothing here blocks a prompt. */
export class UsageService {
  readonly ledger: UsageLedger;
  private budgets: Budgets;
  private warned: Record<string, number[]>;
  private readonly balance: OpenRouterBalance;
  private readonly now: () => number;
  private readonly log: (l: string) => void;

  constructor(private readonly opts: UsageServiceOptions) {
    const dir = opts.config.dir;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.ledger = new UsageLedger(join(dir, "usage.jsonl"));
    this.ledger.load();
    this.budgets = loadBudgets(this.file("budgets.json"), this.log);
    this.warned = this.loadState();
    this.balance = new OpenRouterBalance(opts.config.openrouterKey, this.now, opts.fetch);
  }

  private file(name: string): string {
    return join(this.opts.config.dir, name);
  }

  private loadState(): Record<string, number[]> {
    try {
      const v = JSON.parse(readFileSync(this.file("budget-state.json"), "utf8")) as unknown;
      return typeof v === "object" && v !== null ? (v as Record<string, number[]>) : {};
    } catch {
      return {};
    }
  }

  getBudgets(): Budgets {
    return this.budgets;
  }

  setBudgets(b: Budgets): void {
    writeJsonAtomic(this.file("budgets.json"), b);
    this.budgets = b;
    this.checkBudgets();
  }

  /** Records an assistant message_end from a live session. */
  record(message: unknown, ctx: { sessionId: string; cwd: string; seq: number }): void {
    const row = rowFromMessage(message, {
      sessionId: ctx.sessionId,
      piSessionId: null,
      cwd: ctx.cwd,
      fallbackId: `${ctx.sessionId}:${String(ctx.seq)}`,
      ts: new Date(this.now()).toISOString(),
    });
    if (!row) return;
    try {
      if (!this.ledger.append(row)) return;
    } catch (e) {
      this.log(`usage: append failed: ${(e as Error).message}`);
      return;
    }
    if (row.provider === "openrouter") void this.balance.get().then(() => this.checkBudgets());
    else this.checkBudgets();
  }

  statuses(live: OpenRouterKey | null = this.balance.peek()): BudgetStatus[] {
    const now = new Date(this.now());
    return Object.entries(this.budgets).map(([provider, b]) => {
      let spent: number;
      let isLive = false;
      if (b.kind === "monthly") spent = this.ledger.monthSpend(provider, now);
      else if (provider === "openrouter" && live?.usage != null) {
        spent = live.usage;
        isLive = true;
      } else spent = this.ledger.allTimeSpend(provider);
      return { provider, kind: b.kind, amountUsd: b.amountUsd, spentUsd: spent, pct: (spent / b.amountUsd) * 100, live: isLive };
    });
  }

  /** Emits warnings for thresholds newly crossed; returns them. */
  checkBudgets(): BudgetWarning[] {
    const month = monthKey(new Date(this.now()));
    const crossings = newCrossings(this.statuses(), this.warned, month);
    if (crossings.length === 0) return [];
    try {
      writeJsonAtomic(this.file("budget-state.json"), this.warned);
    } catch (e) {
      this.log(`usage: budget state write failed: ${(e as Error).message}`);
    }
    return crossings.map(({ status, threshold }) => {
      const what = status.kind === "monthly" ? "monthly budget" : "balance";
      const text = `${status.provider} ${what}: ${usd(status.spentUsd)} of ${usd(status.amountUsd)} used (${String(Math.round(status.pct))}%). Prompts are not blocked.`;
      const w = { provider: status.provider, threshold, status, text };
      this.opts.onBudgetWarning?.(w);
      return w;
    });
  }

  async report(): Promise<UsageReport> {
    const live = await this.balance.get();
    return {
      ...this.ledger.summary(new Date(this.now())),
      budgets: this.budgets,
      status: this.statuses(live),
      openrouter: live,
      openrouterConfigured: this.opts.config.openrouterKey !== null,
    };
  }

  /** Imports pi history once; cwds are the directories porcupine has served. */
  async backfill(cwds: Iterable<string>): Promise<number> {
    const all = this.ledger.cwds();
    for (const c of cwds) all.add(c);
    const n = await backfill({
      ledger: this.ledger,
      piSessionsDir: this.opts.config.piSessionsDir,
      marker: this.file("backfill.done"),
      cwds: all,
      log: this.log,
    });
    if (n > 0) this.checkBudgets();
    return n;
  }
}
