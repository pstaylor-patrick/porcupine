/** Web Push crypto with node:crypto only: RFC 8291 aes128gcm payloads and RFC 8292 VAPID ES256 JWTs. */
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";

export const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url");
export const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** HKDF-Expand for output lengths up to one SHA-256 block. */
function expand(prk: Buffer, info: Buffer, len: number): Buffer {
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);
}

export interface EncryptOptions {
  /** Subscription p256dh key (65-byte uncompressed point). */
  uaPublic: Buffer;
  /** Subscription auth secret (16 bytes). */
  authSecret: Buffer;
  /** Test hooks: fixed ephemeral private key and salt. */
  asPrivate?: Buffer;
  salt?: Buffer;
  recordSize?: number;
}

/** Encrypts one record per RFC 8291 / RFC 8188 (aes128gcm content coding). */
export function encryptPayload(plaintext: Buffer, o: EncryptOptions): Buffer {
  const ecdh = createECDH("prime256v1");
  if (o.asPrivate) ecdh.setPrivateKey(o.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(o.uaPublic);
  const salt = o.salt ?? randomBytes(16);
  const rs = o.recordSize ?? 4096;
  if (plaintext.length + 17 > rs) throw new Error("payload too large for one record");

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), o.uaPublic, asPublic]);
  const ikm = expand(hmac(o.authSecret, shared), keyInfo, 32);
  const prk = hmac(salt, ikm);
  const cek = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export interface VapidKeys {
  /** Uncompressed P-256 public point, base64url. */
  publicKey: string;
  /** Private scalar d, base64url. */
  privateKey: string;
}

/** Signs a VAPID JWT (ES256) for the push service at `audience`. */
export function vapidJwt(keys: VapidKeys, audience: string, subject: string, nowSec: number, ttlSec = 12 * 3600): string {
  const pub = unb64u(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const enc = (o: unknown): string => b64u(Buffer.from(JSON.stringify(o)));
  const input = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: audience, exp: nowSec + ttlSec, sub: subject })}`;
  const sig = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(sig)}`;
}
