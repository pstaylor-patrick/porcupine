import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetError, newCrossings, validateBudgets, type BudgetStatus } from "../src/server/usage/budgets.js";
import { usageConfig } from "../src/server/usage/config.js";
import { rowFromMessage, UsageLedger, type UsageRow } from "../src/server/usage/ledger.js";
import { OpenRouterBalance, parseKeyResponse, CACHE_MS } from "../src/server/usage/openrouter.js";
import { UsageService, type BudgetWarning } from "../src/server/usage/service.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "porcupine-usage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function msg(id: string, cost: number, provider = "openrouter", model = "m1", ts = Date.UTC(2026, 9, 1, 12)): unknown {
  return {
    role: "assistant",
    provider,
    model,
    responseId: id,
    timestamp: ts,
    usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, reasoning: 3, cost: { total: cost } },
  };
}

function row(id: string, cost: number, extra: Partial<UsageRow> = {}): UsageRow {
  const r = rowFromMessage(msg(id, cost), { sessionId: "s1", piSessionId: null, cwd: "/w", fallbackId: "fb" });
  if (!r) throw new Error("no row");
  return { ...r, ...extra };
}

describe("usage config", () => {
  it("resolves the data dir like uploads", () => {
    expect(usageConfig({}, "/h").dir).toBe("/h/.local/share/porcupine");
    expect(usageConfig({ XDG_DATA_HOME: "/x" }, "/h").dir).toBe("/x/porcupine");
    expect(usageConfig({ XDG_DATA_HOME: "rel" }, "/h").dir).toBe("/h/.local/share/porcupine");
    expect(usageConfig({}, "/h").openrouterKey).toBeNull();
  });
});

describe("ledger", () => {
  it("ignores non-assistant messages and falls back when responseId is missing", () => {
    expect(rowFromMessage({ role: "user" }, { sessionId: "s", piSessionId: null, cwd: "/", fallbackId: "f" })).toBeNull();
    const r = rowFromMessage({ role: "assistant", usage: {} }, { sessionId: "s", piSessionId: null, cwd: "/", fallbackId: "s:7" });
    expect(r?.responseId).toBe("s:7");
    expect(r?.provider).toBe("unknown");
  });

  it("dedupes on responseId across reloads", () => {
    const file = join(dir, "usage.jsonl");
    const l = new UsageLedger(file);
    expect(l.append(row("a", 1))).toBe(true);
    expect(l.append(row("a", 1))).toBe(false);
    expect(l.append(row("b", 2))).toBe(true);
    const again = new UsageLedger(file);
    again.load();
    expect(again.all()).toHaveLength(2);
    expect(again.append(row("a", 1))).toBe(false);
  });

  it("tolerates a truncated last line and keeps appending on a new line", () => {
    const file = join(dir, "usage.jsonl");
    writeFileSync(file, JSON.stringify(row("a", 1)) + "\n" + '{"ts":"2026-10-01T00:00:00Z","resp');
    const l = new UsageLedger(file);
    l.load();
    expect(l.all()).toHaveLength(1);
    l.append(row("b", 2));
    const again = new UsageLedger(file);
    again.load();
    expect(again.all().map((r) => r.responseId)).toEqual(["a", "b"]);
  });

  it("aggregates by provider, model, session, month and day", () => {
    const l = new UsageLedger(join(dir, "u.jsonl"));
    const now = new Date(2026, 9, 15, 12);
    l.append(row("a", 1, { ts: new Date(2026, 9, 14, 10).toISOString() }));
    l.append(row("b", 2, { ts: new Date(2026, 9, 15, 10).toISOString(), model: "m2" }));
    l.append(row("c", 4, { ts: new Date(2026, 9, 15, 11).toISOString(), provider: "anthropic", sessionId: "s2" }));
    l.append(row("d", 8, { ts: new Date(2026, 8, 30, 11).toISOString() }));
    const s = l.summary(now);
    expect(s.month).toBe("2026-10");
    expect(s.providers.map((p) => [p.provider, p.costUsd])).toEqual([
      ["anthropic", 4],
      ["openrouter", 3],
    ]);
    expect(s.providers[1]?.models.map((m) => m.model)).toEqual(["m2", "m1"]);
    expect(s.sessions.s1?.costUsd).toBe(11);
    expect(s.allTime.openrouter).toBe(11);
    expect(s.daily).toHaveLength(30);
    expect(s.daily.at(-1)).toEqual({ day: "2026-10-15", costUsd: 6 });
    expect(l.monthSpend("openrouter", now)).toBe(3);
  });
});

describe("budgets", () => {
  it("validates", () => {
    expect(validateBudgets({ openrouter: { kind: "balance", amountUsd: 20 } })).toEqual({ openrouter: { kind: "balance", amountUsd: 20 } });
    expect(() => validateBudgets([])).toThrow(BudgetError);
    expect(() => validateBudgets({ x: { kind: "weekly", amountUsd: 1 } })).toThrow(/kind/);
    expect(() => validateBudgets({ x: { kind: "monthly", amountUsd: -1 } })).toThrow(/amountUsd/);
    expect(() => validateBudgets({ "Bad Name": { kind: "monthly", amountUsd: 1 } })).toThrow(/provider/);
  });

  it("reports each threshold once per period", () => {
    const st = (pct: number): BudgetStatus => ({ provider: "anthropic", kind: "monthly", amountUsd: 10, spentUsd: pct / 10, pct, live: false });
    const state: Record<string, number[]> = {};
    expect(newCrossings([st(50)], state, "2026-10")).toEqual([]);
    expect(newCrossings([st(85)], state, "2026-10").map((c) => c.threshold)).toEqual([80]);
    expect(newCrossings([st(90)], state, "2026-10")).toEqual([]);
    expect(newCrossings([st(120)], state, "2026-10").map((c) => c.threshold)).toEqual([100]);
    expect(newCrossings([st(120)], state, "2026-10")).toEqual([]);
    expect(newCrossings([st(120)], state, "2026-11").map((c) => c.threshold)).toEqual([100]);
  });
});

describe("openrouter balance", () => {
  it("parses the key response", () => {
    expect(parseKeyResponse({ data: { limit: 50, limit_remaining: 12.5, usage: 37.5 } })).toEqual({ limit: 50, limitRemaining: 12.5, usage: 37.5 });
    expect(parseKeyResponse({ data: { limit: null, usage: 3 } })).toEqual({ limit: null, limitRemaining: null, usage: 3 });
    expect(parseKeyResponse("nope")).toBeNull();
  });

  it("caches for five minutes and returns null on failure", async () => {
    let t = 0;
    let calls = 0;
    const b = new OpenRouterBalance("k", () => t, async () => {
      calls++;
      if (calls === 2) throw new Error("down");
      return { ok: true, json: async () => ({ data: { limit: 10, limit_remaining: 4, usage: 6 } }) };
    });
    expect((await b.get())?.usage).toBe(6);
    t = CACHE_MS - 1;
    await b.get();
    expect(calls).toBe(1);
    t = CACHE_MS + 1;
    expect(await b.get()).toBeNull();
    expect(calls).toBe(2);
    expect(await new OpenRouterBalance(null, () => 0).get()).toBeNull();
  });
});

describe("usage service", () => {
  const cfg = () => ({ dir: join(dir, "data"), piSessionsDir: join(dir, "pi"), openrouterKey: null });

  it("records live messages, warns once at 80 and 100 percent and never throws", () => {
    const warnings: BudgetWarning[] = [];
    const now = new Date(2026, 9, 15).getTime();
    const svc = new UsageService({ config: cfg(), now: () => now, onBudgetWarning: (w) => warnings.push(w) });
    svc.setBudgets({ anthropic: { kind: "monthly", amountUsd: 10 } });
    svc.record(msg("r1", 5, "anthropic"), { sessionId: "s", cwd: "/w", seq: 1 });
    svc.record(msg("r2", 3.5, "anthropic"), { sessionId: "s", cwd: "/w", seq: 2 });
    svc.record(msg("r2", 3.5, "anthropic"), { sessionId: "s", cwd: "/w", seq: 3 });
    svc.record(msg("r3", 0.1, "anthropic"), { sessionId: "s", cwd: "/w", seq: 4 });
    svc.record(msg("r4", 2, "anthropic"), { sessionId: "s", cwd: "/w", seq: 5 });
    expect(warnings.map((w) => w.threshold)).toEqual([80, 100]);
    expect(warnings[0]?.text).toMatch(/not blocked/);
    const reloaded = new UsageService({ config: cfg(), now: () => now });
    expect(reloaded.ledger.all()).toHaveLength(4);
    expect(reloaded.checkBudgets()).toEqual([]);
    expect(JSON.parse(readFileSync(join(cfg().dir, "budgets.json"), "utf8"))).toEqual({ anthropic: { kind: "monthly", amountUsd: 10 } });
  });

  it("backfills once from pi sessions whose cwd porcupine served", async () => {
    const piDir = join(dir, "pi", "--w--");
    mkdirSync(piDir, { recursive: true });
    const lines = (cwd: string, id: string) =>
      [
        { type: "session", id: `p-${id}`, cwd },
        { type: "message", id: "1", message: { role: "user", content: [] } },
        { type: "message", id: "2", message: msg(`resp-${id}`, 1) },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n{trunc";
    writeFileSync(join(piDir, "a.jsonl"), lines("/served", "a"));
    writeFileSync(join(piDir, "b.jsonl"), lines("/elsewhere", "b"));
    const svc = new UsageService({ config: cfg() });
    expect(await svc.backfill(["/served"])).toBe(1);
    expect(svc.ledger.all()[0]?.piSessionId).toBe("p-a");
    expect(existsSync(join(cfg().dir, "backfill.done"))).toBe(true);
    expect(await svc.backfill(["/served", "/elsewhere"])).toBe(0);
  });
});
