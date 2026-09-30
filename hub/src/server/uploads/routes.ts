import type { IncomingMessage, ServerResponse } from "node:http";
import type { UploadConfig } from "./config.js";
import { saveUpload, UploadError } from "./store.js";

export interface UploadRouteContext {
  config: UploadConfig;
  maxBytes: number;
  origins: string[];
  authed(req: IncomingMessage): boolean;
  sessionExists(id: string): boolean;
  now: () => number;
  log(line: string): void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body) + "\n");
}

/** Handles /api/uploads routes; returns false when the path is not an upload route. */
export async function handleUploads(req: IncomingMessage, res: ServerResponse, ctx: UploadRouteContext): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://hub");
  const path = url.pathname;
  if (path !== "/api/uploads" && !path.startsWith("/api/uploads/")) return false;
  const method = req.method ?? "GET";
  if (!ctx.authed(req)) {
    req.resume();
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  if (path === "/api/uploads/config" && method === "GET") {
    const { confirmUsd, confirmMinutes, whisperBin, whisperModel } = ctx.config;
    json(res, 200, { confirmUsd, confirmMinutes, whisper: whisperBin !== null && whisperModel !== null, maxBytes: ctx.maxBytes });
    return true;
  }
  if (path === "/api/uploads" && method === "POST") {
    const origin = req.headers.origin;
    if (!origin || !ctx.origins.includes(origin)) {
      ctx.log(`upload rejected: bad origin ${origin ?? "(none)"}`);
      req.resume();
      json(res, 403, { error: "forbidden" });
      return true;
    }
    const session = url.searchParams.get("session") ?? "";
    if (!ctx.sessionExists(session)) {
      req.resume();
      json(res, 404, { error: "unknown session" });
      return true;
    }
    req.setTimeout(0);
    try {
      const saved = await saveUpload(req, ctx.config.root, session, url.searchParams.get("name") ?? "", ctx.maxBytes, ctx.now);
      json(res, 201, { id: saved.id, kind: saved.kind, name: saved.name, size: saved.size, path: saved.path, probe: {} });
    } catch (e) {
      const status = e instanceof UploadError ? e.status : 500;
      ctx.log(`upload failed: ${(e as Error).message}`);
      res.setHeader("Connection", "close");
      json(res, status, { error: (e as Error).message });
      if (!req.complete) req.resume();
    }
    return true;
  }
  json(res, 404, { error: "not found" });
  return true;
}
