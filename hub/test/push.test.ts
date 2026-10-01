import { createECDH, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyActivity } from "../src/server/registry.js";
import { b64u, encryptPayload, unb64u, vapidJwt } from "../src/server/push/crypto.js";
import { Notifier } from "../src/server/push/notifier.js";
import { PushSender, type PushFetch } from "../src/server/push/send.js";
import { SubscriptionError, SubscriptionStore, validateSubscription } from "../src/server/push/store.js";
import { loadOrCreateVapid, vapidPath } from "../src/server/push/vapid.js";
import type { PushMessage } from "../src/server/push/send.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "porcupine-push-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("RFC 8291 aes128gcm", () => {
  it("matches the section 5 test vector", () => {
    const out = encryptPayload(Buffer.from("When I grow up, I want to be a watermelon"), {
      asPrivate: unb64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
      uaPublic: unb64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      authSecret: unb64u("BTBZMqHH6r4Tts7J_aSIgg"),
      salt: unb64u("DGv6ra1nlYgDCS1FRnbzlw"),
    });
    expect(b64u(out)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });
});

describe("VAPID", () => {
  it("generates keys once with mode 0600 and reuses them", () => {
    const file = join(dir, "cfg", "porcupine", "vapid.json");
    const a = loadOrCreateVapid(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadOrCreateVapid(file)).toEqual(a);
    expect(unb64u(a.publicKey)).toHaveLength(65);
    expect(vapidPath({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/x/porcupine/vapid.json");
    expect(vapidPath({}, "/h")).toBe("/h/.config/porcupine/vapid.json");
  });

  it("signs an ES256 JWT that verifies with the public key", () => {
    const keys = loadOrCreateVapid(join(dir, "v.json"));
    const jwt = vapidJwt(keys, "https://push.example.net", "mailto:porcupine@localhost", 1000);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(unb64u(h).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(unb64u(p).toString())).toEqual({ aud: "https://push.example.net", exp: 1000 + 12 * 3600, sub: "mailto:porcupine@localhost" });
    const pub = unb64u(keys.publicKey);
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, unb64u(s))).toBe(true);
  });
});

function sub(endpoint: string): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 7)) } };
}

describe("subscriptions", () => {
  it("validates, stores, dedupes and removes", () => {
    expect(() => validateSubscription({ endpoint: "http://x", keys: {} })).toThrow(SubscriptionError);
    expect(() => validateSubscription({ ...sub("https://x/1"), keys: { p256dh: "AA", auth: "AA" } })).toThrow(SubscriptionError);
    const file = join(dir, "subs.json");
    const store = new SubscriptionStore(file);
    store.add(validateSubscription(sub("https://push.example/a")));
    store.add(validateSubscription(sub("https://push.example/a")));
    store.add(validateSubscription(sub("https://push.example/b")));
    expect(new SubscriptionStore(file).list().map((s) => s.endpoint)).toEqual(["https://push.example/a", "https://push.example/b"]);
    expect(store.remove("https://push.example/a")).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
  });

  it("sends with VAPID headers and prunes 404/410", async () => {
    const store = new SubscriptionStore(join(dir, "subs.json"));
    for (const e of ["https://push.example/ok", "https://push.example/gone", "https://push.example/missing"]) store.add(validateSubscription(sub(e)));
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fake: PushFetch = (url, init) => {
      calls.push({ url, headers: init.headers });
      return Promise.resolve({ status: url.endsWith("gone") ? 410 : url.endsWith("missing") ? 404 : 201 });
    };
    const sender = new PushSender({ keys: loadOrCreateVapid(join(dir, "v.json")), store, fetch: fake });
    await sender.send({ title: "t", body: "b" });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(calls[0]?.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(store.list().map((s) => s.endpoint)).toEqual(["https://push.example/ok"]);
  });
});

describe("triggers", () => {
  it("suppresses session pushes while viewed; budget always sends", () => {
    const sent: PushMessage[] = [];
    const n = new Notifier((m) => void sent.push(m));
    const s = { id: "s1", name: "work" };
    n.settled(s, true);
    n.needsInput(s, "Pick one", true);
    expect(sent).toHaveLength(0);
    n.settled(s, false);
    n.needsInput(s, "Pick one", false);
    n.budget("anthropic at 80%");
    expect(sent.map((m) => m.body)).toEqual(["Agent finished", "Needs input: Pick one", "anthropic at 80%"]);
    expect(sent[0]?.session).toBe("s1");
  });

  it("tracks running, unread and needs-input", () => {
    const e = { isStreaming: false, unread: false, needsInput: false };
    expect(applyActivity(e, { type: "agent_start" }, false)).toMatchObject({ changed: true, settled: false });
    expect(applyActivity(e, { type: "extension_ui_request", method: "select", title: "Q" }, false).needsInput).toBe("Q");
    expect(e.needsInput).toBe(true);
    expect(applyActivity(e, { type: "agent_end" }, false).settled).toBe(true);
    expect(applyActivity(e, { type: "agent_settled" }, false).settled).toBe(false);
    expect(e).toEqual({ isStreaming: false, unread: true, needsInput: false });
    const v = { isStreaming: true, unread: false, needsInput: false };
    applyActivity(v, { type: "agent_end" }, true);
    expect(v.unread).toBe(false);
    expect(applyActivity(v, { type: "extension_ui_request", method: "notify" }, false).needsInput).toBeNull();
  });
});
