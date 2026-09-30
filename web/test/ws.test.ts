import { describe, expect, it } from "vitest";
import { Connection, MAX_BACKOFF_MS, nextBackoff, type ServerFrame, type SocketLike } from "../src/ws.js";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const frames: ServerFrame[] = [];
  const store = new Map<string, string>();
  const conn = new Connection(
    {
      url: "ws://x/ws",
      create: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeout: () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined,
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      },
    },
    { onFrame: (f) => frames.push(f), onStatus: () => undefined },
  );
  return { conn, sockets, timers, frames, store };
}

describe("connection", () => {
  it("reconnect sends attach with since=lastSeq and drops already-seen seqs", () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.conn.attach("s1");
    expect(h.sockets[0]!.sent).toContainEqual({ t: "attach", session: "s1", since: null });
    for (const seq of [1, 2, 3]) h.sockets[0]!.push({ t: "event", session: "s1", seq, event: { type: "x" } });
    expect(h.conn.lastSeq).toBe(3);

    h.sockets[0]!.close();
    expect(h.timers.at(-1)?.ms).toBe(500);
    h.timers.at(-1)!.fn();
    h.sockets[1]!.open();
    expect(h.sockets[1]!.sent).toEqual([{ t: "list" }, { t: "attach", session: "s1", since: 3 }]);

    h.sockets[1]!.push({ t: "event", session: "s1", seq: 3, event: { type: "dup" } });
    h.sockets[1]!.push({ t: "event", session: "s1", seq: 4, event: { type: "new" } });
    const events = h.frames.filter((f) => f.t === "event");
    expect(events.map((f) => (f.t === "event" ? f.seq : 0))).toEqual([1, 2, 3, 4]);
  });

  it("restores the cursor from storage", () => {
    const h = harness();
    h.store.set("porcupine.cursor", JSON.stringify({ sessionId: "s9", lastSeq: 41 }));
    const conn2 = new Connection(
      {
        url: "ws://x/ws",
        create: () => {
          const s = new FakeSocket();
          h.sockets.push(s);
          return s;
        },
        setInterval: () => 0,
        storage: { getItem: (k) => h.store.get(k) ?? null, setItem: () => undefined, removeItem: () => undefined },
      },
      { onFrame: () => undefined, onStatus: () => undefined },
    );
    conn2.connect();
    h.sockets[0]!.open();
    expect(h.sockets[0]!.sent).toContainEqual({ t: "attach", session: "s9", since: 41 });
  });

  it("correlates command results by cid", async () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    const p = h.conn.command({ type: "get_state" });
    const sent = h.sockets[0]!.sent.at(-1) as { cid: string };
    h.sockets[0]!.push({ t: "result", cid: sent.cid, response: { success: true, data: { isStreaming: false } } });
    await expect(p).resolves.toEqual({ success: true, data: { isStreaming: false } });
  });

  it("backs off doubling to a cap", () => {
    let b = 0;
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) seen.push((b = nextBackoff(b)));
    expect(seen).toEqual([500, 1000, 2000, 4000, 8000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  });
});
