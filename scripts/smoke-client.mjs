#!/usr/bin/env node
// End-to-end smoke client: drives one porcupine session through the hub over
// the public HTTPS/WSS address. Exits non-zero on the first failed assertion.
// Env: SMOKE_BASE_URL, SMOKE_PASSWORD, SMOKE_SESSION_NAME, SMOKE_TIMEOUT_MS.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(fileURLToPath(new URL("../hub/package.json", import.meta.url)));
const WebSocket = require("ws");

const BASE = process.env.SMOKE_BASE_URL;
if (!BASE) throw new Error("SMOKE_BASE_URL is required (scripts/smoke.sh sets it from PORCUPINE_ORIGIN)");
const PASSWORD = process.env.SMOKE_PASSWORD;
const NAME = process.env.SMOKE_SESSION_NAME ?? "smoke";
const RUN_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);
const EXPECTED_MODEL = { provider: "vercel-ai-gateway", id: "anthropic/claude-opus-5.5" };

function log(msg) {
  console.log(`smoke: ${msg}`);
}
function fail(msg) {
  console.error(`smoke: FAIL ${msg}`);
  process.exit(1);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
  log(`ok ${msg}`);
}

async function login() {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
    redirect: "manual",
  });
  assert(res.status === 303, `login returns 303 (got ${res.status})`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("porcupine_session="));
  assert(Boolean(cookie), "login sets porcupine_session cookie");
  const pair = cookie.split(";")[0];
  const me = await fetch(`${BASE}/api/me`, { headers: { cookie: pair } });
  assert(me.status === 200, `/api/me with cookie returns 200 (got ${me.status})`);
  return pair;
}

class Conn {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    this.waiters = [];
    this.cid = 0;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      this.frames.push(frame);
      for (const w of [...this.waiters]) {
        if (w.pred(frame)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(frame);
        }
      }
    });
    ws.on("close", () => {
      for (const w of this.waiters) {
        clearTimeout(w.timer);
        w.reject(new Error(`socket closed while waiting for ${w.what}`));
      }
      this.waiters = [];
    });
  }

  static open(cookie) {
    const url = BASE.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(url, { headers: { cookie, origin: new URL(BASE).origin } });
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(new Conn(ws)));
      ws.once("error", reject);
    });
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  waitFor(what, pred, timeoutMs = 30_000, includePast = false) {
    if (includePast) {
      const hit = this.frames.find(pred);
      if (hit) return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      this.waiters.push({ what, pred, resolve, reject, timer });
    });
  }

  async cmd(cmd, timeoutMs = 60_000) {
    const cid = `smoke-${++this.cid}`;
    const p = this.waitFor(`result of ${cmd.type}`, (f) => f.t === "result" && f.cid === cid, timeoutMs);
    this.send({ t: "cmd", cid, cmd });
    return (await p).response;
  }

  events() {
    return this.frames.filter((f) => f.t === "event");
  }

  close() {
    return new Promise((resolve) => {
      this.ws.once("close", resolve);
      this.ws.close();
    });
  }
}

function assistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

async function main() {
  if (!PASSWORD) fail("SMOKE_PASSWORD is not set");
  const cookie = await login();

  const conn = await Conn.open(cookie);
  const listed = conn.waitFor("sessions", (f) => f.t === "sessions" && f.sessions.some((s) => s.name === NAME), 30_000, true);
  conn.send({ t: "list" });
  const session = (await listed).sessions.find((s) => s.name === NAME);
  assert(Boolean(session), `list includes session ${NAME} (${session.id})`);

  const attached = conn.waitFor("attached", (f) => f.t === "attached" && f.session === session.id);
  conn.send({ t: "attach", session: session.id, since: null });
  await attached;
  assert(true, "attached");

  const state = await conn.cmd({ type: "get_state" });
  assert(state.success === true, "get_state succeeds");

  const models = await conn.cmd({ type: "get_available_models" });
  const list = models.data?.models ?? [];
  assert(
    models.success && list.some((m) => m.provider === EXPECTED_MODEL.provider && m.id === EXPECTED_MODEL.id),
    `get_available_models includes ${EXPECTED_MODEL.provider}/${EXPECTED_MODEL.id} (${list.length} models)`,
  );

  const thinking = await conn.cmd({ type: "set_thinking_level", level: "low" });
  assert(thinking.success === true, `set_thinking_level low succeeds${thinking.error ? `: ${thinking.error}` : ""}`);

  const settled = conn.waitFor("agent_settled", (f) => f.t === "event" && f.event.type === "agent_settled", RUN_TIMEOUT_MS);
  const prompt = await conn.cmd({ type: "prompt", message: "Reply with exactly the word: porcupine", images: [] });
  assert(prompt.success === true, `prompt accepted${prompt.error ? `: ${prompt.error}` : ""}`);
  await settled;
  assert(true, "run reached agent_settled");

  const ends = conn
    .events()
    .filter((f) => f.event.type === "message_end" && f.event.message?.role === "assistant");
  const reply = ends.at(-1)?.event.message;
  assert(Boolean(reply), "an assistant message_end arrived");
  assert(
    reply.stopReason !== "error" && reply.stopReason !== "aborted",
    `assistant reply is not an error (stopReason=${reply.stopReason}${reply.errorMessage ? `, ${reply.errorMessage}` : ""})`,
  );
  const text = assistantText(reply);
  assert(text.trim().length > 0, `assistant reply has text: ${JSON.stringify(text.slice(0, 80))}`);

  const fresh = await conn.cmd({ type: "new_session" });
  assert(fresh.success === true, `new_session succeeds${fresh.error ? `: ${fresh.error}` : ""}`);

  // Let any trailing events land, then note the cursor and reconnect.
  await new Promise((r) => setTimeout(r, 1000));
  const firstSeqs = conn.events().map((f) => f.seq);
  assert(firstSeqs.length > 0 && new Set(firstSeqs).size === firstSeqs.length, `first connection saw ${firstSeqs.length} unique seqs`);
  await conn.close();

  // Reattach from the middle of the stream: the replay must be exactly the
  // seqs after the cursor, each once.
  const since = firstSeqs[Math.floor(firstSeqs.length / 2)];
  // message_update entries may be compacted once their message_end lands, so
  // only non-update events are required to replay.
  const expected = conn
    .events()
    .filter((f) => f.seq > since && f.event.type !== "message_update")
    .map((f) => f.seq);
  const again = await Conn.open(cookie);
  const reattached = again.waitFor("attached", (f) => f.t === "attached" && f.session === session.id);
  again.send({ t: "attach", session: session.id, since });
  await reattached;
  await again.cmd({ type: "get_state" });
  await new Promise((r) => setTimeout(r, 500));
  const replay = again.events().map((f) => f.seq);
  assert(!again.frames.some((f) => f.t === "reset"), "reattach with since does not reset");
  assert(replay.length > 0 && replay.every((s) => s > since), `reattach since=${since} replays only newer seqs (${replay.length} events)`);
  assert(new Set(replay).size === replay.length, "no duplicate seqs in replay");
  assert(expected.every((s) => replay.includes(s)), "replay covers every non-update event after the cursor");
  await again.close();

  process.stdout.write(`SESSION_ID=${session.id}\n`);
  log("client checks passed");
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
