import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildChildEnv, buildPiArgs } from "../src/cli/args.js";
import { startSession, type Session } from "../src/cli/session.js";
import { JsonlSplitter, toJsonl } from "../src/shared/jsonl.js";
import type { CliToHubFrame } from "../src/shared/protocol.js";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

class Client {
  readonly frames: CliToHubFrame[] = [];
  private waiters: (() => void)[] = [];
  private constructor(readonly sock: Socket) {
    const s = new JsonlSplitter();
    sock.on("data", (c: Buffer) => {
      for (const l of s.push(c)) this.frames.push(JSON.parse(l) as CliToHubFrame);
      this.waiters.splice(0).forEach((w) => w());
    });
    sock.on("close", () => this.waiters.splice(0).forEach((w) => w()));
  }
  static open(path: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const sock = connect(path, () => resolve(new Client(sock)));
      sock.once("error", reject);
    });
  }
  send(v: unknown): void {
    this.sock.write(toJsonl(v));
  }
  async until<T extends CliToHubFrame>(pred: (f: CliToHubFrame) => boolean, ms = 5000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const f = this.frames.find(pred);
      if (f) return f as T;
      if (Date.now() > deadline || this.sock.destroyed) throw new Error(`timed out; frames=${JSON.stringify(this.frames)}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
  }
  close(): void {
    this.sock.destroy();
  }
}

let dir: string;
let session: Session | null = null;
const logs: string[] = [];

async function start(extraEnv: Record<string, string> = {}, userArgs: string[] = []): Promise<Session> {
  dir = mkdtempSync(join(tmpdir(), "porcupine-test-"));
  logs.length = 0;
  session = await startSession({
    name: "My Test",
    cwd: dir,
    piBin: FAKE_PI,
    piArgs: buildPiArgs(userArgs),
    childEnv: buildChildEnv({ ...process.env, ...extraEnv }, { VERCEL_AI_GATEWAY_API_KEY: "vk", PORCUPINE_RPC_PASSWORD: "hunter2" }),
    runtimeDir: join(dir, "run"),
    log: (l) => logs.push(l),
    stdinGraceMs: 500,
    termGraceMs: 500,
    expectedPiVersion: "0.99.1",
  });
  return session;
}

afterEach(async () => {
  await session?.shutdown();
  session = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("porcupine session", () => {
  it("registers, writes metadata and socket with tight modes", async () => {
    const s = await start();
    expect(existsSync(s.paths.sock)).toBe(true);
    const meta = JSON.parse(readFileSync(s.paths.meta, "utf8"));
    expect(meta).toMatchObject({
      id: `my-test-${process.pid}`,
      name: "My Test",
      cwd: dir,
      piVersion: "0.99.1",
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-5.5",
    });
    expect(meta.piPid).toBeGreaterThan(0);
    expect(statSync(s.paths.sock).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "run")).mode & 0o777).toBe(0o700);
    expect(logs.some((l) => l.startsWith("registered My Test"))).toBe(true);
  });

  it("passes args and env to pi without leaking the password", async () => {
    const argsFile = join(tmpdir(), `fake-args-${process.pid}.json`);
    const envFile = join(tmpdir(), `fake-env-${process.pid}.json`);
    await start({ FAKE_PI_ARGS_FILE: argsFile, FAKE_PI_ENV_FILE: envFile, PORCUPINE_RPC_PASSWORD: "hunter2" });
    const args = JSON.parse(readFileSync(argsFile, "utf8"));
    expect(args).toEqual(["--mode", "rpc", "--provider", "vercel-ai-gateway", "--model", "anthropic/claude-sonnet-5.5"]);
    const env = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
    expect(env.AI_GATEWAY_API_KEY).toBe("vk");
    expect(env.PORCUPINE_RPC_PASSWORD).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("hunter2");
    rmSync(argsFile, { force: true });
    rmSync(envFile, { force: true });
  });

  it("correlates command results by cid and enforces the allowlist", async () => {
    const s = await start();
    const c = await Client.open(s.paths.sock);
    c.send({ t: "hello", proto: 1, since: null });
    await c.until((f) => f.t === "welcome");
    c.send({ t: "cmd", cid: "a", cmd: { type: "get_state", id: "evil" } });
    c.send({ t: "cmd", cid: "b", cmd: { type: "get_messages" } });
    c.send({ t: "cmd", cid: "c", cmd: { type: "bash", command: "rm -rf /" } });
    c.send({ t: "cmd", cid: "d", cmd: { type: "switch_session" } });
    const a = await c.until((f) => f.t === "result" && f.cid === "a");
    const b = await c.until((f) => f.t === "result" && f.cid === "b");
    const cc = await c.until((f) => f.t === "result" && f.cid === "c");
    const d = await c.until((f) => f.t === "result" && f.cid === "d");
    expect(a.t === "result" && a.response).toMatchObject({ success: true, command: "get_state" });
    expect(a.t === "result" && a.response.id).toMatch(/^p\d+$/);
    expect(b.t === "result" && b.response).toMatchObject({ success: true, command: "get_messages" });
    expect(cc.t === "result" && cc.response).toEqual({ success: false, error: "command not allowed" });
    expect(d.t === "result" && d.response).toEqual({ success: false, error: "command not allowed" });
    c.close();
  });

  it("streams events with seq and replays since on reconnect", async () => {
    const s = await start();
    const c = await Client.open(s.paths.sock);
    c.send({ t: "hello", proto: 1, since: null });
    const welcome = await c.until((f) => f.t === "welcome");
    expect(welcome.t === "welcome" && welcome.headSeq).toBe(0);
    expect(c.frames.some((f) => f.t === "reset")).toBe(true);
    c.send({ t: "cmd", cid: "p", cmd: { type: "prompt", message: "hi", images: [] } });
    await c.until((f) => f.t === "event" && f.event.type === "agent_settled");
    const seqs = c.frames.flatMap((f) => (f.t === "event" ? [f.seq] : []));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(logs).toContain("run started");
    expect(logs).toContain("run settled");
    c.close();

    const c2 = await Client.open(s.paths.sock);
    c2.send({ t: "hello", proto: 1, since: 2 });
    await c2.until((f) => f.t === "welcome");
    await new Promise((r) => setTimeout(r, 100));
    expect(c2.frames.some((f) => f.t === "reset")).toBe(false);
    const replayed = c2.frames.flatMap((f) => (f.t === "event" ? [f.seq] : []));
    expect(replayed.length).toBeGreaterThan(0);
    expect(Math.min(...replayed)).toBeGreaterThan(2);
    c2.close();
  });

  it("sends reset when the cursor is older than the buffer", async () => {
    dir = mkdtempSync(join(tmpdir(), "porcupine-test-"));
    session = await startSession({
      name: "small",
      cwd: dir,
      piBin: FAKE_PI,
      piArgs: buildPiArgs([]),
      childEnv: process.env,
      runtimeDir: join(dir, "run"),
      log: () => undefined,
      limits: { maxEvents: 2, maxBytes: 1e9 },
      stdinGraceMs: 500,
      termGraceMs: 500,
    });
    const c = await Client.open(session.paths.sock);
    c.send({ t: "hello", proto: 1, since: 0 });
    await c.until((f) => f.t === "welcome");
    c.send({ t: "cmd", cid: "p", cmd: { type: "prompt", message: "hi", images: [] } });
    await c.until((f) => f.t === "event" && f.event.type === "agent_settled");
    c.close();
    const c2 = await Client.open(session.paths.sock);
    c2.send({ t: "hello", proto: 1, since: 1 });
    await c2.until((f) => f.t === "reset");
    c2.close();
  });

  it("auto-cancels extension UI dialogs and surfaces a notice", async () => {
    const s = await start();
    const c = await Client.open(s.paths.sock);
    c.send({ t: "hello", proto: 1, since: null });
    c.send({ t: "cmd", cid: "u", cmd: { type: "prompt", message: "__ui__", images: [] } });
    const notice = await c.until((f) => f.t === "event" && f.event.type === "porcupine_notice");
    expect(notice.t === "event" && notice.event.text).toBe("extension UI confirm auto-cancelled: Allow?");
    const answer = await c.until((f) => f.t === "event" && f.event.type === "fake_ui_answer");
    expect(answer.t === "event" && answer.event.response).toStrictEqual({
      type: "extension_ui_response",
      id: "ui-1",
      cancelled: true,
    });
    await c.until((f) => f.t === "result" && f.cid === "u");
    expect(logs.some((l) => l.includes("auto-cancelled"))).toBe(true);
    c.close();
  });

  it("removes socket and metadata on shutdown", async () => {
    const s = await start();
    const code = await s.shutdown();
    expect(code).toBe(0);
    expect(existsSync(s.paths.sock)).toBe(false);
    expect(existsSync(s.paths.meta)).toBe(false);
  });

  it("broadcasts session_ended and cleans up when pi dies", async () => {
    const s = await start();
    const c = await Client.open(s.paths.sock);
    c.send({ t: "hello", proto: 1, since: null });
    await c.until((f) => f.t === "welcome");
    process.kill(s.meta.piPid, "SIGKILL");
    const ended = await c.until((f) => f.t === "session_ended");
    expect(ended.t === "session_ended" && ended.code).toBe(137);
    expect(await s.done).toBe(137);
    expect(existsSync(s.paths.sock)).toBe(false);
    expect(existsSync(s.paths.meta)).toBe(false);
  });
});
