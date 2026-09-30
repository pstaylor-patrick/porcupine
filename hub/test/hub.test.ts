import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildPiArgs } from "../src/cli/args.js";
import { startSession, type Session } from "../src/cli/session.js";
import { COOKIE_NAME, signCookie } from "../src/server/auth.js";
import type { HubConfig } from "../src/server/config.js";
import { createHub, type Hub } from "../src/server/hub.js";
import { isPublicPath } from "../src/server/static.js";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const ORIGIN = "https://porcupine.example.com";
const SECRET = "c".repeat(64);

let dir: string;
let runtimeDir: string;
let hub: Hub;
let base: string;
let session: Session | null;
const sockets: WebSocket[] = [];

function config(): HubConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dev: false,
    origins: [ORIGIN],
    password: "hunter2",
    cookieSecret: SECRET,
    cookieTtlSec: 3600,
    runtimeDir,
    webDist: join(dir, "web"),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "porcupine-hub-"));
  runtimeDir = join(dir, "run");
  mkdirSync(runtimeDir, { mode: 0o700 });
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "index.html"), "<!doctype html><title>app</title>");
  mkdirSync(join(dir, "web", "fonts"));
  writeFileSync(join(dir, "web", "fonts", "texgyreschola-regular-latin.woff2"), "wOF2");
  mkdirSync(join(dir, "web", "crayon"));
  writeFileSync(join(dir, "web", "crayon", "scribble.svg"), "<svg/>");
  session = null;
  hub = createHub({ config: config(), log: () => undefined, rescanMs: 100 });
  const { port } = await hub.listen();
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.terminate());
  await hub.close();
  await session?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function startFake(): Promise<Session> {
  session = await startSession({
    name: "fake",
    cwd: dir,
    piBin: FAKE_PI,
    piArgs: buildPiArgs([]),
    childEnv: process.env,
    runtimeDir,
    log: () => undefined,
    stdinGraceMs: 300,
    termGraceMs: 300,
  });
  return session;
}

type Frame = Record<string, unknown> & { t: string };
class Browser {
  frames: Frame[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => this.frames.push(JSON.parse(d.toString()) as Frame));
  }
  send(v: unknown): void {
    this.ws.send(JSON.stringify(v));
  }
  until(pred: (f: Frame) => boolean): Promise<Frame> {
    return waitFor(() => this.frames.find(pred));
  }
}

function cookie(): string {
  return `${COOKIE_NAME}=${signCookie(SECRET, 3600)}`;
}

function openWs(headers: Record<string, string>): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers });
    sockets.push(ws);
    ws.on("open", () => resolve({ ws }));
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.on("error", () => resolve({}));
  });
}

async function browser(): Promise<Browser> {
  const { ws } = await openWs({ Cookie: cookie(), Origin: ORIGIN });
  if (!ws) throw new Error("upgrade failed");
  return new Browser(ws);
}

describe("hub HTTP and auth", () => {
  it("/api/me is 401 without a cookie and 200 with one; security headers present", async () => {
    const r = await fetch(`${base}/api/me`);
    expect(r.status).toBe(401);
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${base}/api/me`, { headers: { Cookie: cookie() } })).status).toBe(200);
  });

  it("login sets a Secure HttpOnly SameSite=Strict cookie; wrong password does not", async () => {
    const bad = await fetch(`${base}/api/login`, { method: "POST", body: "password=nope", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(bad.headers.get("set-cookie")).toBeNull();
    const ok = await fetch(`${base}/api/login`, { method: "POST", body: "password=hunter2", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(ok.status).toBe(303);
    const sc = ok.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Strict/);
    const me = await fetch(`${base}/api/me`, { headers: { Cookie: sc.split(";")[0] as string } });
    expect(me.status).toBe(200);
  });

  it("rate limits login after 5 failures", async () => {
    const post = () => fetch(`${base}/api/login`, { method: "POST", body: "password=x", redirect: "manual" });
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(303);
    expect((await post()).status).toBe(429);
  });

  it("redirects the unauthenticated app shell to /login and serves it when authed", async () => {
    const r = await fetch(`${base}/`, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/login");
    expect((await fetch(`${base}/login`)).status).toBe(200);
    const app = await fetch(`${base}/`, { headers: { Cookie: cookie() } });
    expect(await app.text()).toContain("<title>app</title>");
    expect(app.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves /fonts/ woff2 without a cookie as font/woff2", async () => {
    expect(isPublicPath("/fonts/texgyreschola-regular-latin.woff2")).toBe(true);
    const r = await fetch(`${base}/fonts/texgyreschola-regular-latin.woff2`, { redirect: "manual" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("font/woff2");
  });

  it("serves /crayon/ svgs without a cookie as image/svg+xml", async () => {
    expect(isPublicPath("/crayon/scribble.svg")).toBe(true);
    expect(isPublicPath("/crayonx")).toBe(false);
    const r = await fetch(`${base}/crayon/scribble.svg`, { redirect: "manual" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("serves /theme-init.js without a cookie", async () => {
    expect(isPublicPath("/theme-init.js")).toBe(true);
    const r = await fetch(`${base}/theme-init.js`, { redirect: "manual" });
    expect(r.status).not.toBe(303);
    expect(r.status).not.toBe(401);
  });

  it("rejects a tampered cookie", async () => {
    const r = await fetch(`${base}/api/me`, { headers: { Cookie: `${cookie()}x` } });
    expect(r.status).toBe(401);
  });
});

describe("WebSocket upgrade", () => {
  it("rejects without a cookie", async () => {
    expect((await openWs({ Origin: ORIGIN })).status).toBe(401);
  });
  it("rejects a bad or missing Origin", async () => {
    expect((await openWs({ Cookie: cookie(), Origin: "https://evil.example" })).status).toBe(403);
    expect((await openWs({ Cookie: cookie() })).status).toBe(403);
  });
  it("accepts a valid cookie and Origin and answers ping", async () => {
    const b = await browser();
    b.send({ t: "ping" });
    await b.until((f) => f.t === "pong");
  });
});

describe("registry", () => {
  it("discovers a live CLI and prunes a stale one with a dead pid", async () => {
    const stale = { id: "ghost-1", name: "ghost", cwd: "/", pid: 2147483646, piPid: -1, startedAt: new Date().toISOString(), piVersion: null, provider: null, model: null };
    writeFileSync(join(runtimeDir, "ghost-1.json"), JSON.stringify(stale));
    writeFileSync(join(runtimeDir, "ghost-1.sock"), "");
    const s = await startFake();
    await waitFor(() => hub.registry.list().some((x) => x.id === s.meta.id));
    await waitFor(() => !existsSync(join(runtimeDir, "ghost-1.json")));
    expect(existsSync(join(runtimeDir, "ghost-1.sock"))).toBe(false);
    expect(hub.registry.list().map((x) => x.id)).toEqual([s.meta.id]);
  });
});

describe("relay", () => {
  it("round trips browser -> hub -> CLI -> fake pi and back, then replays only newer seqs on reconnect", async () => {
    const s = await startFake();
    await waitFor(() => hub.registry.list().length === 1);
    const b = await browser();
    b.send({ t: "list" });
    const list = await b.until((f) => f.t === "sessions" && (f.sessions as unknown[]).length === 1);
    expect((list.sessions as { id: string }[])[0]?.id).toBe(s.meta.id);

    b.send({ t: "attach", session: s.meta.id, since: null });
    await b.until((f) => f.t === "attached");
    b.send({ t: "cmd", cid: "c1", cmd: { type: "get_state" } });
    const res = await b.until((f) => f.t === "result" && f.cid === "c1");
    expect((res.response as { success: boolean }).success).toBe(true);

    b.send({ t: "cmd", cid: "c2", cmd: { type: "prompt", message: "hi", images: [] } });
    await b.until((f) => f.t === "event" && (f.event as { type: string }).type === "agent_settled");
    const seqs = b.frames.filter((f) => f.t === "event").map((f) => f.seq as number);
    expect(seqs.length).toBeGreaterThan(3);
    const last = seqs[seqs.length - 1] as number;

    b.send({ t: "cmd", cid: "c3", cmd: { type: "bash", command: "id" } });
    const denied = await b.until((f) => f.t === "result" && f.cid === "c3");
    expect((denied.response as { error: string }).error).toBe("command not allowed");

    b.ws.close();
    const since = last - 2;
    const b2 = await browser();
    b2.send({ t: "attach", session: s.meta.id, since });
    const attached = await b2.until((f) => f.t === "attached");
    expect(attached.headSeq).toBe(last);
    await b2.until((f) => f.t === "event" && f.seq === last);
    const replayed = b2.frames.filter((f) => f.t === "event").map((f) => f.seq as number);
    expect(replayed).toEqual([last - 1, last]);
    expect(b2.frames.some((f) => f.t === "reset")).toBe(false);

    await s.shutdown();
    session = null;
    await b2.until((f) => f.t === "session_ended");
    await waitFor(() => hub.registry.list().length === 0);
  });
});
