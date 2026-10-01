import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASK_TITLE_PREFIX } from "../src/extension/ask-user-question.js";
import { Registry } from "../src/server/registry.js";
import { toJsonl } from "../src/shared/jsonl.js";
import { PROTOCOL_VERSION } from "../src/shared/protocol.js";

const ID = "e9a631507618-1";
const meta = { id: ID, name: "E9A631507618", cwd: "/", pid: process.pid, piPid: -1, startedAt: new Date().toISOString(), piVersion: null, provider: null, model: null };
const ask = `${ASK_TITLE_PREFIX}${JSON.stringify({ questions: [{ question: "Should the close-out include outside attorney review?" }] })}`;
const history = [
  { type: "agent_start" },
  { type: "extension_ui_request", id: "q1", method: "select", title: ask },
  { type: "porcupine_ui_resolved", id: "q1" },
  { type: "agent_end" },
];

let dir: string;
let server: Server | null = null;
let registry: Registry | null = null;
let live: Socket | null = null;

afterEach(() => {
  registry?.stop();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function fakeCli(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "porcupine-replay-"));
  writeFileSync(join(dir, `${ID}.json`), JSON.stringify(meta));
  server = createServer((sock) => {
    live = sock;
    sock.once("data", () => {
      sock.write(toJsonl({ t: "welcome", proto: PROTOCOL_VERSION, meta, headSeq: history.length, oldestSeq: 1 }));
      sock.write(toJsonl({ t: "reset" }));
      history.forEach((event, i) => sock.write(toJsonl({ t: "event", seq: i + 1, event })));
    });
  });
  await new Promise<void>((r) => server?.listen(join(dir, `${ID}.sock`), r));
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe("registry replay", () => {
  it("does not notify for a question answered before the hub (re)connected, but does for a live one", async () => {
    await fakeCli();
    const asks: string[] = [];
    const settled: string[] = [];
    let seen = 0;
    registry = new Registry({
      runtimeDir: dir,
      rescanMs: 60_000,
      onNeedsInput: (_m, title) => asks.push(title),
      onSettled: (m) => settled.push(m.id),
      onEvent: () => void seen++,
    });
    await registry.start();
    await until(() => seen === history.length);
    expect(asks).toEqual([]);
    expect(settled).toEqual([]);
    expect(registry.list()[0]?.needsInput).toBe(false);

    live?.write(toJsonl({ t: "event", seq: history.length + 1, event: { type: "extension_ui_request", id: "q2", method: "select", title: ask } }));
    await until(() => asks.length === 1);
    expect(registry.list()[0]?.needsInput).toBe(true);
  });
});
