import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import loop, { type Api, type Clock, type Ctx } from "../src/extension/loop/index.js";
import { ENTRY_TYPE, parseInterval, parseLoopArgs } from "../src/extension/loop/schedule.js";

describe("parsing", () => {
  it("parses intervals", () => {
    expect(parseInterval("30s")).toBe(30);
    expect(parseInterval("5m")).toBe(300);
    expect(parseInterval("1h")).toBe(3600);
    expect(parseInterval("90")).toBe(90);
    expect(parseInterval("1s")).toBeUndefined();
    expect(parseInterval("five")).toBeUndefined();
  });
  it("parses /loop arguments", () => {
    expect(parseLoopArgs("stop")).toEqual({ kind: "stop" });
    expect(parseLoopArgs("")).toEqual({ kind: "status" });
    expect(parseLoopArgs("5m check the deploy")).toEqual({ kind: "start", prompt: "check the deploy", intervalSec: 300 });
    expect(parseLoopArgs("check the deploy")).toEqual({ kind: "start", prompt: "check the deploy", intervalSec: null });
    expect(parseLoopArgs("5m")).toEqual({ kind: "error" });
  });
});

type Tool = Parameters<Api["registerTool"]>[0];

function setup(entries: { type: string; customType?: string; data?: unknown }[] = []) {
  const handlers: Record<string, (e: unknown, c: Ctx) => void> = {};
  const tools: Record<string, Tool> = {};
  let cmd: ((a: string, c: Ctx) => Promise<void>) | undefined;
  const sent: { text: string; opts: unknown }[] = [];
  const status: (string | undefined)[] = [];
  let idle = true;
  const api: Api = {
    on: (ev, h) => {
      handlers[ev] = h;
    },
    registerCommand: (_n, o) => {
      cmd = o.handler;
    },
    registerTool: (t) => {
      tools[t.name] = t;
    },
    appendEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage: (text, opts) => {
      sent.push({ text, opts });
    },
  };
  const ctx: Ctx = {
    hasUI: true,
    ui: { notify: () => undefined, setStatus: (_k, t) => status.push(t) },
    isIdle: () => idle,
    sessionManager: { getEntries: () => entries },
  };
  const clock: Clock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as never) };
  loop(api, clock);
  return {
    handlers,
    tools,
    run: (a: string) => (cmd as (a: string, c: Ctx) => Promise<void>)(a, ctx),
    ctx,
    sent,
    status,
    entries,
    setIdle: (v: boolean) => {
      idle = v;
    },
  };
}

describe("loop extension", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks on a fixed interval when idle and queues a follow-up when busy", async () => {
    const t = setup();
    await t.run("1m ping");
    expect(t.sent).toEqual([{ text: "ping", opts: undefined }]);
    t.setIdle(false);
    vi.advanceTimersByTime(60_000);
    expect(t.sent[1]).toEqual({ text: "ping", opts: { deliverAs: "followUp" } });
    expect(t.status.at(-1)).toMatch(/every 1m/);
    await t.run("stop");
    vi.advanceTimersByTime(600_000);
    expect(t.sent).toHaveLength(2);
    expect(t.status.at(-1)).toBeUndefined();
  });

  it("self-paces through schedule_next and stop_loop", async () => {
    const t = setup();
    await t.run("watch CI");
    expect(t.sent).toHaveLength(1);
    t.handlers["agent_start"]?.({}, t.ctx);
    await t.tools["schedule_next"]?.execute("1", { delaySec: 30, reason: "build running" }, undefined, undefined, t.ctx);
    t.handlers["agent_end"]?.({}, t.ctx);
    vi.advanceTimersByTime(29_000);
    expect(t.sent).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(t.sent).toHaveLength(2);
    await t.tools["stop_loop"]?.execute("2", { reason: "green" }, undefined, undefined, t.ctx);
    vi.advanceTimersByTime(3_600_000);
    expect(t.sent).toHaveLength(2);
  });

  it("falls back to a default delay when a self-paced run skips schedule_next", async () => {
    const t = setup();
    await t.run("watch CI");
    t.handlers["agent_start"]?.({}, t.ctx);
    t.handlers["agent_end"]?.({}, t.ctx);
    vi.advanceTimersByTime(600_000);
    expect(t.sent).toHaveLength(2);
  });

  it("re-arms persisted state on session start", async () => {
    const first = setup();
    await first.run("5m ping");
    const entries = first.entries.filter((e) => e.customType === ENTRY_TYPE);
    vi.advanceTimersByTime(120_000);
    first.handlers["session_shutdown"]?.({}, first.ctx);
    const second = setup(entries);
    second.handlers["session_start"]?.({}, second.ctx);
    vi.advanceTimersByTime(179_000);
    expect(second.sent).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(second.sent).toEqual([{ text: "ping", opts: undefined }]);
  });

  it("restores nothing after stop", async () => {
    const first = setup();
    await first.run("5m ping");
    await first.run("stop");
    const second = setup(first.entries);
    second.handlers["session_start"]?.({}, second.ctx);
    vi.advanceTimersByTime(3_600_000);
    expect(second.sent).toHaveLength(0);
  });
});
