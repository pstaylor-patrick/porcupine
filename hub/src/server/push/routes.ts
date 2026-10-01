import type { IncomingMessage, ServerResponse } from "node:http";
import type { PushSender } from "./send.js";
import { SubscriptionError, validateSubscription, type SubscriptionStore } from "./store.js";

export interface PushRouteContext {
  sender: PushSender;
  store: SubscriptionStore;
  origins: string[];
  authed(req: IncomingMessage): boolean;
  log(line: string): void;
}

const BODY_LIMIT = 8 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body) + "\n");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new SubscriptionError("body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new SubscriptionError("invalid JSON");
  }
}

/** Handles /api/push/key, /api/push/subscribe and /api/push/unsubscribe; false for other paths. */
export async function handlePush(req: IncomingMessage, res: ServerResponse, ctx: PushRouteContext): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://hub").pathname;
  if (path !== "/api/push/key" && path !== "/api/push/subscribe" && path !== "/api/push/unsubscribe") return false;
  const method = req.method ?? "GET";
  if (!ctx.authed(req)) {
    req.resume();
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  if (path === "/api/push/key") {
    req.resume();
    if (method !== "GET") json(res, 405, { error: "method not allowed" });
    else json(res, 200, { publicKey: ctx.sender.publicKey });
    return true;
  }
  if (method !== "POST") {
    req.resume();
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  const origin = req.headers.origin;
  if (!origin || !ctx.origins.includes(origin)) {
    ctx.log(`push rejected: bad origin ${origin ?? "(none)"}`);
    req.resume();
    json(res, 403, { error: "forbidden" });
    return true;
  }
  try {
    const body = await readJson(req);
    if (path === "/api/push/subscribe") {
      ctx.store.add(validateSubscription(body));
      json(res, 200, { subscribed: true });
    } else {
      const endpoint = body && typeof body === "object" ? (body as { endpoint?: unknown }).endpoint : undefined;
      if (typeof endpoint !== "string") throw new SubscriptionError("endpoint required");
      ctx.store.remove(endpoint);
      json(res, 200, { subscribed: false });
    }
  } catch (e) {
    if (!(e instanceof SubscriptionError)) ctx.log(`push route failed: ${(e as Error).message}`);
    json(res, e instanceof SubscriptionError ? (e.message === "body too large" ? 413 : 400) : 500, { error: (e as Error).message });
  }
  return true;
}
