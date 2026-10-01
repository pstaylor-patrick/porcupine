import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class SubscriptionError extends Error {}

/** Validates a browser PushSubscription.toJSON() body. Only https endpoints. */
export function validateSubscription(v: unknown): PushSubscriptionRecord {
  if (!v || typeof v !== "object") throw new SubscriptionError("subscription required");
  const s = v as Record<string, unknown>;
  const keys = s.keys as Record<string, unknown> | undefined;
  if (typeof s.endpoint !== "string" || s.endpoint.length > 2048) throw new SubscriptionError("endpoint required");
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    throw new SubscriptionError("invalid endpoint");
  }
  if (url.protocol !== "https:") throw new SubscriptionError("endpoint must be https");
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof p256dh !== "string" || Buffer.from(p256dh, "base64url").length !== 65) throw new SubscriptionError("invalid p256dh key");
  if (typeof auth !== "string" || Buffer.from(auth, "base64url").length !== 16) throw new SubscriptionError("invalid auth secret");
  return { endpoint: s.endpoint, keys: { p256dh, auth } };
}

/** push-subscriptions.json, written atomically. */
export class SubscriptionStore {
  private subs: PushSubscriptionRecord[];

  constructor(private readonly file: string) {
    this.subs = this.load();
  }

  private load(): PushSubscriptionRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((r) => {
        try {
          return [validateSubscription(r)];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.subs, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list(): PushSubscriptionRecord[] {
    return [...this.subs];
  }

  add(s: PushSubscriptionRecord): void {
    this.subs = [...this.subs.filter((x) => x.endpoint !== s.endpoint), s];
    this.save();
  }

  remove(endpoint: string): boolean {
    const before = this.subs.length;
    this.subs = this.subs.filter((x) => x.endpoint !== endpoint);
    if (this.subs.length === before) return false;
    this.save();
    return true;
  }
}
