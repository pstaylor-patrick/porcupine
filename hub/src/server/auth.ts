import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const COOKIE_NAME = "porcupine_session";
export type Clock = () => number;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Compares SHA-256 digests with timingSafeEqual so length and content do not leak timing. */
export function passwordMatches(input: string, expected: string): boolean {
  return timingSafeEqual(sha256(input), sha256(expected));
}

interface CookiePayload {
  v: 1;
  iat: number;
  exp: number;
}

const hmac = (secret: string, data: string): Buffer => createHmac("sha256", secret).update(data).digest();

export function signCookie(secret: string, ttlSec: number, now: Clock = Date.now): string {
  const iat = Math.floor(now() / 1000);
  const payload: CookiePayload = { v: 1, iat, exp: iat + ttlSec };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(secret, body).toString("base64url")}`;
}

export function verifyCookie(secret: string, value: string | undefined, now: Clock = Date.now): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot !== value.lastIndexOf(".")) return false;
  const body = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = hmac(secret, body);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<CookiePayload>;
    return p.v === 1 && typeof p.exp === "number" && p.exp > Math.floor(now() / 1000);
  } catch {
    return false;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function isAuthed(req: IncomingMessage, secret: string, now: Clock = Date.now): boolean {
  return verifyCookie(secret, parseCookies(req.headers.cookie)[COOKIE_NAME], now);
}

export function sessionCookie(value: string, ttlSec: number, secure: boolean): string {
  return `${COOKIE_NAME}=${value}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Path=/; Max-Age=${ttlSec}`;
}

export function clearedCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * Peers allowed to set X-Forwarded-For: loopback, and Docker bridge addresses
 * (172.16.0.0/12), where the shared shared Caddy container connects from.
 */
export function isTrustedProxy(peer: string): boolean {
  const v4 = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
  if (v4 === "127.0.0.1" || peer === "::1") return true;
  const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(v4);
  const second = m ? Number(m[1]) : -1;
  return second >= 16 && second <= 31;
}

/** Remote IP: X-Forwarded-For is trusted only when the socket peer is a trusted proxy (Caddy). */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const xff = req.headers["x-forwarded-for"];
  if (isTrustedProxy(peer) && typeof xff === "string" && xff.trim()) {
    const parts = xff.split(",");
    return (parts[parts.length - 1] as string).trim();
  }
  return peer;
}

export interface RateLimitOptions {
  perIp: number;
  global: number;
  windowMs: number;
  now?: Clock;
}

/** Counts failed logins in a sliding window, per IP and globally. */
export class LoginRateLimiter {
  private readonly perIp = new Map<string, number[]>();
  private global: number[] = [];
  private readonly now: Clock;

  constructor(private readonly opts: RateLimitOptions = { perIp: 5, global: 20, windowMs: 15 * 60 * 1000 }) {
    this.now = opts.now ?? Date.now;
  }

  private prune(list: number[]): number[] {
    const cutoff = this.now() - this.opts.windowMs;
    return list.filter((t) => t > cutoff);
  }

  blocked(ip: string): boolean {
    this.global = this.prune(this.global);
    const mine = this.prune(this.perIp.get(ip) ?? []);
    if (mine.length) this.perIp.set(ip, mine);
    else this.perIp.delete(ip);
    return mine.length >= this.opts.perIp || this.global.length >= this.opts.global;
  }

  fail(ip: string): void {
    const t = this.now();
    this.global.push(t);
    this.perIp.set(ip, [...this.prune(this.perIp.get(ip) ?? []), t]);
  }
}
