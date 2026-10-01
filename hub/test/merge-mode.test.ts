import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cfSessionId, handleMergeMode, type RubyRunner } from "../src/server/merge-mode.js";
import { cfIdPath } from "../src/shared/paths.js";

const ORIGIN = "https://porcupine.test";
let dir: string;
let server: Server;
let base: string;
let store: Map<string, string>;
let calls: { args: string[]; stdin: string }[];

/** Stands in for cf's Ruby: the read script and merge_mode_record.rb over an in-memory store. */
const ruby: RubyRunner = (args, stdin) => {
  calls.push({ args, stdin });
  if (args[0] === "-e") {
    const stored = store.get(args[3] as string) ?? null;
    const out = { mode: stored ?? "merge-ready", stored, fallback: "merge-ready", modes: ["local-only", "merge-ready", "admin-bypass", "yolo"] };
    return Promise.resolve({ code: 0, stdout: JSON.stringify(out), stderr: "" });
  }
  const ev = JSON.parse(stdin) as { session_id: string; tool_response: { questions: { question: string }[]; answers: Record<string, string> } };
  const q = ev.tool_response.questions[0]?.question ?? "";
  store.set(ev.session_id, ev.tool_response.answers[q] ?? "");
  return Promise.resolve({ code: 0, stdout: "", stderr: "" });
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "porcupine-mm-"));
  store = new Map();
  calls = [];
  server = createServer((req, res) => {
    void handleMergeMode(req, res, {
      origins: [ORIGIN],
      authed: (r) => r.headers.cookie === "ok",
      sessionExists: (id) => id === "proj-1",
      runtimeDir: dir,
      cfBin: "/cf/bin",
      ruby,
      log: () => undefined,
    }).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? String(a.port) : "0"}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const url = (id = "proj-1"): string => `${base}/api/sessions/${id}/merge-mode`;

describe("merge-mode route", () => {
  it("rejects unauthenticated requests, unknown sessions and bad origins", async () => {
    expect((await fetch(url())).status).toBe(401);
    expect((await fetch(url("nope"), { headers: { cookie: "ok" } })).status).toBe(404);
    const r = await fetch(url(), { method: "POST", headers: { cookie: "ok", origin: "https://evil.test" }, body: '{"mode":"yolo"}' });
    expect(r.status).toBe(403);
    expect(store.size).toBe(0);
  });

  it("shows cf's fallback when unset and records a mode through merge_mode_record.rb", async () => {
    const r = await fetch(url(), { headers: { cookie: "ok" } });
    expect(await r.json()).toMatchObject({ sessionId: "proj-1", mode: "merge-ready", stored: null, fallback: "merge-ready" });
    const w = await fetch(url(), { method: "POST", headers: { cookie: "ok", origin: ORIGIN }, body: '{"mode":"yolo"}' });
    expect(w.status).toBe(200);
    expect(await w.json()).toMatchObject({ mode: "yolo", stored: "yolo" });
    expect(calls.some((c) => c.args[0] === "/cf/bin/merge_mode_record.rb")).toBe(true);
    const bad = await fetch(url(), { method: "POST", headers: { cookie: "ok", origin: ORIGIN }, body: '{"mode":"chaos"}' });
    expect(bad.status).toBe(400);
  });

  it("uses the cf session id the hooks extension recorded", async () => {
    writeFileSync(cfIdPath(dir, "proj-1"), "persisted-id\n");
    expect(cfSessionId(dir, "proj-1")).toBe("persisted-id");
    await fetch(url(), { method: "POST", headers: { cookie: "ok", origin: ORIGIN }, body: '{"mode":"local-only"}' });
    expect(store.get("persisted-id")).toBe("local-only");
  });
});
