import { encryptPayload, unb64u, vapidJwt, type VapidKeys } from "./crypto.js";
import type { PushSubscriptionRecord, SubscriptionStore } from "./store.js";

export type PushFetch = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number }>;

export interface PushMessage {
  title: string;
  body: string;
  /** Session to open on click. */
  session?: string;
  /** Collapses repeated notifications for the same thing. */
  tag?: string;
}

export interface PushSenderOptions {
  keys: VapidKeys;
  store: SubscriptionStore;
  subject?: string | undefined;
  fetch?: PushFetch | undefined;
  now?: () => number;
  log?: (line: string) => void;
}

/** Sends encrypted pushes to every stored subscription; prunes 404/410. */
export class PushSender {
  constructor(private readonly o: PushSenderOptions) {}

  get publicKey(): string {
    return this.o.keys.publicKey;
  }

  async sendOne(sub: PushSubscriptionRecord, msg: PushMessage): Promise<number> {
    const now = this.o.now ?? Date.now;
    const doFetch: PushFetch = this.o.fetch ?? ((url, init) => fetch(url, init));
    const jwt = vapidJwt(this.o.keys, new URL(sub.endpoint).origin, this.o.subject ?? "mailto:porcupine@localhost", Math.floor(now() / 1000));
    const body = encryptPayload(Buffer.from(JSON.stringify(msg)), { uaPublic: unb64u(sub.keys.p256dh), authSecret: unb64u(sub.keys.auth) });
    const res = await doFetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${this.o.keys.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "normal",
      },
      body,
    });
    return res.status;
  }

  async send(msg: PushMessage): Promise<void> {
    await Promise.all(
      this.o.store.list().map(async (sub) => {
        let host = "push service";
        try {
          host = new URL(sub.endpoint).host;
          const status = await this.sendOne(sub, msg);
          if (status === 404 || status === 410) {
            this.o.store.remove(sub.endpoint);
            this.o.log?.(`push: pruned expired subscription at ${host}`);
          } else if (status >= 400) {
            this.o.log?.(`push: ${host} answered ${String(status)}`);
          }
        } catch (e) {
          this.o.log?.(`push: send to ${host} failed: ${(e as Error).message}`);
        }
      }),
    );
  }
}
