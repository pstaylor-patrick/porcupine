import { describe, expect, it, vi } from "vitest";
import autocompact, { type Api, type Ctx } from "../src/extension/autocompact/index.js";
import { configFromEnv, effectiveThreshold, parseOverride } from "../src/extension/autocompact/threshold.js";

const cfg = configFromEnv({});

describe("threshold math", () => {
  it("defaults to 250000 tokens and 80 percent", () => {
    expect(cfg).toEqual({ tokens: 250_000, fallbackPct: 80 });
  });
  it("falls back to percent when the window is at or below the threshold", () => {
    expect(effectiveThreshold(128_000, cfg, null)).toBe(102_400);
    expect(effectiveThreshold(250_000, cfg, null)).toBe(200_000);
  });
  it("uses the token threshold for large windows", () => {
    expect(effectiveThreshold(1_000_000, cfg, null)).toBe(250_000);
  });
  it("honours off and overrides", () => {
    expect(effectiveThreshold(1_000_000, cfg, "off")).toBeNull();
    expect(effectiveThreshold(1_000_000, { tokens: "off", fallbackPct: 80 }, null)).toBeNull();
    expect(effectiveThreshold(1_000_000, cfg, 400_000)).toBe(400_000);
    expect(effectiveThreshold(200_000, cfg, 100_000)).toBe(100_000);
  });
  it("reads env and rejects junk", () => {
    expect(configFromEnv({ PORCUPINE_AUTOCOMPACT_TOKENS: "150000", PORCUPINE_AUTOCOMPACT_FALLBACK_PCT: "70" })).toEqual({ tokens: 150_000, fallbackPct: 70 });
    expect(configFromEnv({ PORCUPINE_AUTOCOMPACT_TOKENS: "abc", PORCUPINE_AUTOCOMPACT_FALLBACK_PCT: "500" })).toEqual(cfg);
  });
  it("parses /autocompact arguments", () => {
    expect(parseOverride("off")).toBe("off");
    expect(parseOverride("default")).toBeNull();
    expect(parseOverride("120,000")).toBe(120_000);
    expect(parseOverride("-5")).toBeUndefined();
  });
});

describe("extension", () => {
  function setup(): { handlers: Record<string, (e: unknown, c: Ctx) => void>; cmd: (a: string, c: Ctx) => Promise<void>; entries: unknown[] } {
    const handlers: Record<string, (e: unknown, c: Ctx) => void> = {};
    let cmd: ((a: string, c: Ctx) => Promise<void>) | undefined;
    const entries: unknown[] = [];
    const api: Api = {
      on: (ev, h) => (handlers[ev] = h),
      registerCommand: (_n, o) => (cmd = o.handler),
      appendEntry: (t, d) => entries.push({ type: "custom", customType: t, data: d }),
    };
    autocompact(api, {});
    if (!cmd) throw new Error("no command");
    return { handlers, cmd, entries };
  }
  const ctx = (tokens: number | null, window = 128_000): Ctx & { compact: ReturnType<typeof vi.fn> } => ({
    getContextUsage: () => ({ tokens, contextWindow: window, percent: null }),
    compact: vi.fn(),
  });

  it("compacts once per run past the threshold", () => {
    const { handlers } = setup();
    const c = ctx(110_000);
    handlers.turn_end?.({}, c);
    handlers.turn_end?.({}, c);
    expect(c.compact).toHaveBeenCalledTimes(1);
  });
  it("skips below threshold or with unknown usage", () => {
    const { handlers } = setup();
    const c = ctx(90_000);
    handlers.turn_end?.({}, c);
    handlers.turn_end?.({}, ctx(null));
    expect(c.compact).not.toHaveBeenCalled();
  });
  it("persists and restores the override", async () => {
    const a = setup();
    await a.cmd("off", ctx(0));
    expect(a.entries).toEqual([{ type: "custom", customType: "porcupine_autocompact", data: { value: "off" } }]);
    const b = setup();
    b.handlers.session_start?.({}, { ...ctx(0), sessionManager: { getEntries: () => a.entries as never } });
    const c = ctx(127_000);
    b.handlers.turn_end?.({}, c);
    expect(c.compact).not.toHaveBeenCalled();
  });
});
