// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  bannerFromReport,
  dailyChart,
  formatUsd,
  parseSessionUsage,
  readBudgetForm,
  addBudgetRow,
  renderBudgetForm,
  renderUsage,
  sessionUsageText,
  type UsageReport,
} from "../src/usage.js";

const report = (): UsageReport => ({
  month: "2026-10",
  providers: [
    { provider: "anthropic", input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, costUsd: 9, models: [{ model: "claude", input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, costUsd: 9 }] },
  ],
  daily: [
    { day: "2026-10-01", costUsd: 0 },
    { day: "2026-10-02", costUsd: 9 },
  ],
  budgets: { anthropic: { kind: "monthly", amountUsd: 10 } },
  status: [{ provider: "anthropic", kind: "monthly", amountUsd: 10, spentUsd: 9, pct: 90, live: false }],
  openrouter: null,
  openrouterConfigured: true,
});

describe("usage helpers", () => {
  it("formats money and session stats", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(12.5)).toBe("$12.50");
    const u = parseSessionUsage({ tokens: { input: 1500, output: 20, cacheRead: 0, cacheWrite: 0, total: 1520 }, cost: 0.25 });
    expect(u?.cost).toBe(0.25);
    expect(sessionUsageText(u)).toBe("1.5K in, 20 out, 0 cache read - $0.25");
    expect(parseSessionUsage({})).toBeNull();
  });

  it("builds an SVG bar chart with DOM APIs", () => {
    const svg = dailyChart(report().daily);
    const bars = svg.querySelectorAll("rect");
    expect(bars).toHaveLength(2);
    expect(bars[0]?.getAttribute("height")).toBe("0.0");
    expect(Number(bars[1]?.getAttribute("height"))).toBeGreaterThan(70);
    expect(svg.getAttribute("aria-label")).toMatch(/\$9\.00 total/);
  });

  it("renders providers, progress and the unavailable OpenRouter balance", () => {
    const root = document.createElement("div");
    renderUsage(root, report());
    const bar = root.querySelector<HTMLElement>(".ctx-bar");
    expect(bar?.getAttribute("aria-valuenow")).toBe("90");
    expect(bar?.dataset.level).toBe("high");
    expect(root.textContent).toContain("OpenRouter balance: unavailable");
    expect(root.querySelector(".usage-models li")?.textContent).toContain("claude");
    expect([...root.querySelectorAll("[style]")].every((e) => e.classList.contains("ctx-fill"))).toBe(true);
  });

  it("round-trips the budget form and rejects bad input", () => {
    const rows = document.createElement("div");
    renderBudgetForm(rows, { anthropic: { kind: "monthly", amountUsd: 10 } }, ["openrouter"]);
    expect(rows.querySelectorAll(".budget-row")).toHaveLength(2);
    expect(readBudgetForm(rows)).toEqual({ anthropic: { kind: "monthly", amountUsd: 10 } });
    const amt = rows.querySelectorAll<HTMLInputElement>(".budget-amount")[1];
    if (amt) amt.value = "-3";
    expect(readBudgetForm(rows)).toMatch(/positive/);
  });

  it("picks providers from a list and adds each at most once", () => {
    const rows = document.createElement("div");
    renderBudgetForm(rows, {}, ["openrouter"]);
    expect(rows.querySelector(".budget-provider")?.tagName).toBe("SELECT");
    expect(addBudgetRow(rows)?.querySelector("select")?.value).toBe("anthropic");
    expect(addBudgetRow(rows)?.querySelector("select")?.value).toBe("openai");
    expect(addBudgetRow(rows)).toBeNull();
  });

  it("raises a banner at 80% and above", () => {
    expect(bannerFromReport(report())?.level).toBe("warn");
    const over = report();
    over.status[0] = { provider: "anthropic", kind: "monthly", amountUsd: 10, spentUsd: 12, pct: 120, live: false };
    expect(bannerFromReport(over)?.level).toBe("error");
    over.status = [];
    expect(bannerFromReport(over)).toBeNull();
  });
});
