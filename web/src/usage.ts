/** Usage and budgets: settings sections, session cost, budget banner. DOM APIs only (CSP). */
import { el } from "./render.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export type BudgetKind = "monthly" | "balance";
export interface Budget {
  kind: BudgetKind;
  amountUsd: number;
}
export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}
export interface UsageReport {
  month: string;
  providers: (Totals & { provider: string; models: (Totals & { model: string })[] })[];
  daily: { day: string; costUsd: number }[];
  budgets: Record<string, Budget>;
  status: { provider: string; kind: BudgetKind; amountUsd: number; spentUsd: number; pct: number; live: boolean }[];
  openrouter: { limit: number | null; limitRemaining: number | null; usage: number | null } | null;
  openrouterConfigured: boolean;
}

/** "$0.0042", "$1.23", "$120.50": more digits for small amounts. */
export function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/** Parses tokens and cost from pi's get_session_stats. */
export function parseSessionUsage(stats: unknown): SessionUsage | null {
  if (!isRec(stats) || !isRec(stats.tokens)) return null;
  const t = stats.tokens;
  return { input: num(t.input), output: num(t.output), cacheRead: num(t.cacheRead), cacheWrite: num(t.cacheWrite), total: num(t.total), cost: num(stats.cost) };
}

export function sessionUsageText(u: SessionUsage | null): string {
  if (!u) return "unknown";
  return `${formatTokens(u.input)} in, ${formatTokens(u.output)} out, ${formatTokens(u.cacheRead)} cache read - ${formatUsd(u.cost)}`;
}

/** Daily spend as an SVG bar chart built with createElementNS. */
export function dailyChart(daily: { day: string; costUsd: number }[]): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const w = 300;
  const h = 80;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${String(w)} ${String(h)}`);
  svg.setAttribute("class", "usage-chart");
  svg.setAttribute("role", "img");
  const total = daily.reduce((s, d) => s + d.costUsd, 0);
  svg.setAttribute("aria-label", `Daily spend, last ${String(daily.length)} days, ${formatUsd(total)} total`);
  const max = Math.max(...daily.map((d) => d.costUsd), 0);
  const step = daily.length > 0 ? w / daily.length : w;
  daily.forEach((d, i) => {
    const bh = max > 0 ? Math.max((d.costUsd / max) * (h - 2), d.costUsd > 0 ? 1 : 0) : 0;
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", (i * step + 1).toFixed(1));
    rect.setAttribute("y", (h - bh).toFixed(1));
    rect.setAttribute("width", Math.max(step - 2, 1).toFixed(1));
    rect.setAttribute("height", bh.toFixed(1));
    rect.setAttribute("class", "usage-bar");
    const title = document.createElementNS(NS, "title");
    title.textContent = `${d.day}: ${formatUsd(d.costUsd)}`;
    rect.append(title);
    svg.append(rect);
  });
  return svg;
}

function progressFor(s: UsageReport["status"][number]): HTMLElement {
  const pct = Math.min(Math.max(s.pct, 0), 100);
  const p = el("div", { class: "ctx-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct)) }, el("span", { class: "ctx-fill" }));
  (p.firstElementChild as HTMLElement).style.width = `${String(pct)}%`;
  if (s.pct >= 80) p.dataset.level = "high";
  const label = `${formatUsd(s.spentUsd)} of ${formatUsd(s.amountUsd)} ${s.kind === "monthly" ? "this month" : s.live ? "balance (live)" : "balance (local estimate)"} - ${String(Math.round(s.pct))}%`;
  p.setAttribute("aria-label", `${s.provider} budget: ${label}`);
  return el("div", { class: "usage-budget" }, p, el("p", { class: "field-hint" }, label));
}

/** Fills the Usage section. */
export function renderUsage(root: HTMLElement, r: UsageReport): void {
  root.replaceChildren();
  const providers = new Set([...r.providers.map((p) => p.provider), ...r.status.map((s) => s.provider)]);
  if (providers.size === 0) root.append(el("p", { class: "field-hint" }, `No usage recorded for ${r.month}.`));
  for (const name of providers) {
    const p = r.providers.find((x) => x.provider === name);
    const s = r.status.find((x) => x.provider === name);
    const card = el("div", { class: "usage-provider" });
    card.append(
      el("div", { class: "usage-row" }, el("strong", {}, name), el("span", {}, `${formatUsd(p?.costUsd ?? 0)} this month`)),
    );
    if (s) card.append(progressFor(s));
    if (p && p.models.length > 0) {
      const list = el("ul", { class: "usage-models" });
      for (const m of p.models) list.append(el("li", {}, el("span", {}, m.model.replace(/^~/, "")), el("span", {}, formatUsd(m.costUsd))));
      card.append(list);
    }
    root.append(card);
  }
  const or = r.openrouter;
  const orText = !r.openrouterConfigured
    ? null
    : or === null
      ? "OpenRouter balance: unavailable"
      : or.limitRemaining !== null
        ? `OpenRouter balance: ${formatUsd(or.limitRemaining)} left of ${formatUsd(or.limit ?? 0)}`
        : `OpenRouter usage: ${formatUsd(or.usage ?? 0)} (no limit set)`;
  if (orText) root.append(el("p", { class: "field-hint" }, orText));
  // A chart needs at least two days with spend to show a trend; until then it is just empty space.
  if (r.daily.filter((d) => d.costUsd > 0).length >= 2) {
    root.append(el("p", { class: "field-label" }, `Daily spend, last ${String(r.daily.length)} days`), dailyChart(r.daily));
  }
}

/** Providers Porcupine has keys for; a budget picks from these rather than free text. */
export const BUDGET_PROVIDERS = ["openrouter", "anthropic", "openai"] as const;

function usedProviders(rows: HTMLElement): Set<string> {
  return new Set([...rows.querySelectorAll<HTMLSelectElement>(".budget-provider")].map((s) => s.value));
}

/** One editable budget row. */
function budgetRow(provider: string, b: Budget | null): HTMLElement {
  const known: readonly string[] = BUDGET_PROVIDERS;
  const options = known.includes(provider) ? known : [provider, ...known];
  const name = el("select", { class: "budget-provider", "aria-label": "Provider" }, ...options.map((o) => el("option", { value: o }, o)));
  name.value = provider;
  const kind = el("select", { class: "budget-kind", "aria-label": "Budget kind" }, el("option", { value: "monthly" }, "Monthly"), el("option", { value: "balance" }, "Balance"));
  kind.value = b?.kind ?? (provider === "openrouter" ? "balance" : "monthly");
  const amount = el("input", { type: "number", class: "budget-amount", min: "0.01", step: "0.01", inputmode: "decimal", "aria-label": "Amount in USD", placeholder: "$ amount" });
  amount.value = b ? String(b.amountUsd) : "";
  const remove = el("button", { type: "button", class: "budget-remove", "aria-label": "Remove budget" }, "✕");
  const row = el("div", { class: "budget-row" }, name, kind, amount, remove);
  remove.addEventListener("click", () => row.remove());
  return row;
}

export function renderBudgetForm(rows: HTMLElement, budgets: Record<string, Budget>, providers: string[]): void {
  rows.replaceChildren();
  const names = new Set([...Object.keys(budgets), ...providers]);
  for (const n of names) rows.append(budgetRow(n, budgets[n] ?? null));
  if (names.size === 0) addBudgetRow(rows);
}

/** Adds a row for the first provider without one; returns it, or null when every provider has a row. */
export function addBudgetRow(rows: HTMLElement): HTMLElement | null {
  const used = usedProviders(rows);
  const next = BUDGET_PROVIDERS.find((p) => !used.has(p));
  if (!next) return null;
  const row = budgetRow(next, null);
  rows.append(row);
  return row;
}

/** Reads the form; rows with an empty amount are dropped. Returns an error string on invalid input. */
export function readBudgetForm(rows: HTMLElement): Record<string, Budget> | string {
  const out: Record<string, Budget> = {};
  for (const row of rows.querySelectorAll<HTMLElement>(".budget-row")) {
    const provider = (row.querySelector(".budget-provider") as HTMLSelectElement).value;
    const kind = (row.querySelector(".budget-kind") as HTMLSelectElement).value as BudgetKind;
    const raw = (row.querySelector(".budget-amount") as HTMLInputElement).value.trim();
    if (raw === "") continue;
    if (provider in out) return `${provider} has two budgets.`;
    const amountUsd = Number(raw);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return `${provider}: amount must be a positive number.`;
    out[provider] = { kind, amountUsd };
  }
  return out;
}

/** Banner state from GET /api/usage: the most severe budget at or over 80%. */
export function bannerFromReport(r: UsageReport): { level: "warn" | "error"; text: string } | null {
  const worst = [...r.status].sort((a, b) => b.pct - a.pct)[0];
  if (!worst || worst.pct < 80) return null;
  return {
    level: worst.pct >= 100 ? "error" : "warn",
    text: `${worst.provider} ${worst.kind === "monthly" ? "monthly budget" : "balance"}: ${formatUsd(worst.spentUsd)} of ${formatUsd(worst.amountUsd)} used (${String(Math.round(worst.pct))}%). Prompts are not blocked.`,
  };
}
