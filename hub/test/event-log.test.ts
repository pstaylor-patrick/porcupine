import { describe, expect, it } from "vitest";
import { EventLog, limitsFromEnv } from "../src/cli/event-log.js";

const ev = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });

describe("EventLog", () => {
  it("assigns increasing seq starting at 1", () => {
    const log = new EventLog();
    expect(log.append(ev("a")).seq).toBe(1);
    expect(log.append(ev("b")).seq).toBe(2);
    expect(log.headSeq).toBe(2);
    expect(log.oldestSeq).toBe(1);
  });

  it("replays only events after since", () => {
    const log = new EventLog();
    for (let i = 0; i < 5; i++) log.append(ev("x", { i }));
    const r = log.since(3);
    expect(r.reset).toBe(false);
    expect(r.entries.map((e) => e.seq)).toEqual([4, 5]);
    expect(log.since(5).entries).toEqual([]);
  });

  it("resets on null since and replays everything", () => {
    const log = new EventLog();
    log.append(ev("a"));
    const r = log.since(null);
    expect(r.reset).toBe(true);
    expect(r.entries.map((e) => e.seq)).toEqual([1]);
  });

  it("resets when the cursor has rolled out of the buffer", () => {
    const log = new EventLog({ maxEvents: 3, maxBytes: 1e9 });
    for (let i = 0; i < 10; i++) log.append(ev("x"));
    expect(log.oldestSeq).toBe(8);
    expect(log.since(7).reset).toBe(false);
    const r = log.since(5);
    expect(r.reset).toBe(true);
    expect(r.entries.map((e) => e.seq)).toEqual([8, 9, 10]);
  });

  it("resets when the cursor is ahead of head", () => {
    const log = new EventLog();
    log.append(ev("a"));
    expect(log.since(9).reset).toBe(true);
  });

  it("evicts by byte budget", () => {
    const log = new EventLog({ maxEvents: 1000, maxBytes: 100 });
    for (let i = 0; i < 10; i++) log.append(ev("x", { pad: "y".repeat(30) }));
    expect(log.length).toBeLessThan(10);
    expect(log.headSeq).toBe(10);
  });

  it("compacts message_update entries once message_end arrives", () => {
    const log = new EventLog();
    log.append(ev("agent_start"));
    log.append(ev("message_start"));
    log.append(ev("message_update"));
    log.append(ev("message_update"));
    log.append(ev("message_end"));
    expect(log.since(0).entries.map((e) => e.event.type)).toEqual(["agent_start", "message_start", "message_end"]);
    expect(log.since(0).entries.map((e) => e.seq)).toEqual([1, 2, 5]);
  });

  it("reads PORCUPINE_EVENT_BUFFER", () => {
    expect(limitsFromEnv("10").maxEvents).toBe(10);
    expect(limitsFromEnv("junk").maxEvents).toBe(5000);
  });
});
