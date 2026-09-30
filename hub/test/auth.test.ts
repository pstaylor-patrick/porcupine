import { describe, expect, it } from "vitest";
import { LoginRateLimiter, clientIp, parseCookies, passwordMatches, signCookie, verifyCookie } from "../src/server/auth.js";
import type { IncomingMessage } from "node:http";

const SECRET = "s".repeat(64);

describe("passwordMatches", () => {
  it("accepts the exact password and rejects others, including different lengths", () => {
    expect(passwordMatches("hunter2", "hunter2")).toBe(true);
    expect(passwordMatches("hunter3", "hunter2")).toBe(false);
    expect(passwordMatches("", "hunter2")).toBe(false);
    expect(passwordMatches("hunter2hunter2", "hunter2")).toBe(false);
  });
});

describe("session cookie", () => {
  const t0 = 1_700_000_000_000;
  it("verifies a freshly signed cookie", () => {
    const c = signCookie(SECRET, 60, () => t0);
    expect(verifyCookie(SECRET, c, () => t0 + 1000)).toBe(true);
  });
  it("rejects an expired cookie", () => {
    const c = signCookie(SECRET, 60, () => t0);
    expect(verifyCookie(SECRET, c, () => t0 + 60_000)).toBe(false);
  });
  it("rejects a tampered payload, a tampered signature, another secret and junk", () => {
    const c = signCookie(SECRET, 60, () => t0);
    const [body, sig] = c.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ v: 1, iat: 0, exp: 9e12 })).toString("base64url");
    expect(verifyCookie(SECRET, `${forged}.${sig}`, () => t0)).toBe(false);
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect(verifyCookie(SECRET, `${body}.${flipped}`, () => t0)).toBe(false);
    expect(verifyCookie("t".repeat(64), c, () => t0)).toBe(false);
    for (const junk of [undefined, "", ".", "abc", `${body}.`, `${c}.x`]) expect(verifyCookie(SECRET, junk, () => t0)).toBe(false);
  });
  it("parses the cookie header", () => {
    expect(parseCookies("a=1; porcupine_session=x.y; b=2")).toEqual({ a: "1", porcupine_session: "x.y", b: "2" });
  });
});

describe("LoginRateLimiter", () => {
  it("blocks per IP after 5 failures until the window passes", () => {
    let t = 0;
    const rl = new LoginRateLimiter({ perIp: 5, global: 20, windowMs: 15 * 60_000, now: () => t });
    for (let i = 0; i < 5; i++) {
      expect(rl.blocked("1.1.1.1")).toBe(false);
      rl.fail("1.1.1.1");
      t += 1000;
    }
    expect(rl.blocked("1.1.1.1")).toBe(true);
    expect(rl.blocked("2.2.2.2")).toBe(false);
    t = 15 * 60_000 + 500; // first failure (t=0) has aged out
    expect(rl.blocked("1.1.1.1")).toBe(false);
  });
  it("blocks globally after 20 failures across IPs", () => {
    let t = 0;
    const rl = new LoginRateLimiter({ perIp: 5, global: 20, windowMs: 15 * 60_000, now: () => t });
    for (let i = 0; i < 20; i++) rl.fail(`10.0.0.${i}`);
    expect(rl.blocked("9.9.9.9")).toBe(true);
    t = 15 * 60_000 + 1;
    expect(rl.blocked("9.9.9.9")).toBe(false);
  });
});

describe("clientIp", () => {
  const req = (peer: string, xff?: string): IncomingMessage =>
    ({ socket: { remoteAddress: peer }, headers: xff ? { "x-forwarded-for": xff } : {} }) as unknown as IncomingMessage;
  it("trusts X-Forwarded-For only from loopback", () => {
    expect(clientIp(req("127.0.0.1", "100.1.2.3"))).toBe("100.1.2.3");
    expect(clientIp(req("100.9.9.9", "1.2.3.4"))).toBe("100.9.9.9");
  });
});
