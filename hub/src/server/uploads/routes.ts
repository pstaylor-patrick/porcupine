import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { UploadConfig } from "./config.js";
import { MAX_UPLOADS_PER_MESSAGE } from "./config.js";
import { estimateUpload, sumEstimates } from "./estimate.js";
import { probeUpload, processUpload } from "./process.js";
import { loadUpload, saveUpload, UploadError } from "./store.js";
import { makeTools, type Tools } from "./tools.js";

export interface UploadRouteContext {
  config: UploadConfig;
  maxBytes: number;
  origins: string[];
  authed(req: IncomingMessage): boolean;
  sessionExists(id: string): boolean;
  now: () => number;
  log(line: string): void;
  tools?: Tools;
}

const BODY_LIMIT = 16 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new UploadError(413, "body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new UploadError(400, "invalid JSON");
  }
}

function parseIds(body: unknown): { session: string; ids: string[] } {
  const b = body as { session?: unknown; ids?: unknown } | null;
  if (!b || typeof b.session !== "string" || !Array.isArray(b.ids) || !b.ids.every((i) => typeof i === "string")) {
    throw new UploadError(400, "expected { session, ids }");
  }
  if (b.ids.length === 0 || b.ids.length > MAX_UPLOADS_PER_MESSAGE) throw new UploadError(400, `ids must have 1 to ${MAX_UPLOADS_PER_MESSAGE} entries`);
  return { session: b.session, ids: [...new Set(b.ids as string[])] };
}

function originOk(req: IncomingMessage, ctx: UploadRouteContext): boolean {
  const origin = req.headers.origin;
  if (origin && ctx.origins.includes(origin)) return true;
  ctx.log(`upload rejected: bad origin ${origin ?? "(none)"}`);
  return false;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body) + "\n");
}

const defaultTools = makeTools();

/** Handles /api/uploads routes; returns false when the path is not an upload route. */
export async function handleUploads(req: IncomingMessage, res: ServerResponse, ctx: UploadRouteContext): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://hub");
  const path = url.pathname;
  if (path !== "/api/uploads" && !path.startsWith("/api/uploads/")) return false;
  const method = req.method ?? "GET";
  const tools = ctx.tools ?? defaultTools;
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
  if (path === "/api/uploads/file" && (method === "GET" || method === "HEAD")) {
    await serveUpload(req, res, ctx, url.searchParams.get("session") ?? "", url.searchParams.get("id") ?? "");
    return true;
  }
  if (path === "/api/uploads" && method === "POST") {
    if (!originOk(req, ctx)) {
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
      let probe = {};
      try {
        probe = await probeUpload(saved.dir, saved, tools);
      } catch (e) {
        ctx.log(`upload probe failed: ${(e as Error).message}`);
      }
      json(res, 201, { id: saved.id, kind: saved.kind, name: saved.name, size: saved.size, path: saved.path, probe });
    } catch (e) {
      const status = e instanceof UploadError ? e.status : 500;
      ctx.log(`upload failed: ${(e as Error).message}`);
      res.setHeader("Connection", "close");
      json(res, status, { error: (e as Error).message });
      if (!req.complete) req.resume();
    }
    return true;
  }
  if ((path === "/api/uploads/estimate" || path === "/api/uploads/process") && method === "POST") {
    if (!originOk(req, ctx)) {
      req.resume();
      json(res, 403, { error: "forbidden" });
      return true;
    }
    let parsed: { session: string; ids: string[] };
    try {
      parsed = parseIds(await readJson(req));
    } catch (e) {
      json(res, e instanceof UploadError ? e.status : 400, { error: (e as Error).message });
      return true;
    }
    const metas = await Promise.all(parsed.ids.map((id) => loadUpload(ctx.config.root, parsed.session, id)));
    const missing = parsed.ids.filter((_, i) => metas[i] === null);
    if (missing.length > 0) {
      json(res, 404, { error: "unknown upload", ids: missing });
      return true;
    }
    const found = metas.filter((m): m is NonNullable<typeof m> => m !== null);
    if (path === "/api/uploads/estimate") {
      const uploads = [];
      for (const m of found) {
        try {
          const probe = await probeUpload(m.dir, m, tools);
          uploads.push({ id: m.id, kind: m.kind, ...probe, ...estimateUpload(m, probe) });
        } catch (e) {
          uploads.push({ id: m.id, kind: m.kind, error: (e as Error).message, ...estimateUpload(m, {}) });
        }
      }
      json(res, 200, { uploads, total: sumEstimates(uploads) });
      return true;
    }
    req.setTimeout(0);
    res.setTimeout(0);
    const results = [];
    for (const m of found) {
      try {
        results.push(await processUpload(m.dir, m, ctx.config, tools));
      } catch (e) {
        ctx.log(`upload process failed id=${m.id}: ${(e as Error).message}`);
        results.push({ id: m.id, kind: m.kind, name: m.name, error: (e as Error).message });
      }
    }
    json(res, 200, { results });
    return true;
  }
  json(res, 404, { error: "not found" });
  return true;
}

/** Media types the browser may render inline; anything else downloads. The type is the client's claim, so only these pass. */
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp|bmp|heic|heif)|video\/(mp4|quicktime|webm|x-matroska|x-m4v)|audio\/[a-z0-9.+-]+)$/;

/** Streams an upload's original file with Range support, which iOS needs to play video. */
async function serveUpload(req: IncomingMessage, res: ServerResponse, ctx: UploadRouteContext, session: string, id: string): Promise<void> {
  const meta = await loadUpload(ctx.config.root, session, id);
  if (!meta) {
    json(res, 404, { error: "unknown upload" });
    return;
  }
  let size: number;
  try {
    size = (await stat(meta.path)).size;
  } catch {
    json(res, 404, { error: "file gone" });
    return;
  }
  const mime = meta.mime.toLowerCase();
  const inline = INLINE_MIME.test(mime);
  res.setHeader("Content-Type", inline ? mime : "application/octet-stream");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("Accept-Ranges", "bytes");
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${String(size)}` });
      res.end();
      return;
    }
    res.writeHead(206, { "Content-Range": `bytes ${String(start)}-${String(end)}/${String(size)}`, "Content-Length": String(end - start + 1) });
  } else {
    res.writeHead(200, { "Content-Length": String(size) });
  }
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  createReadStream(meta.path, { start, end }).on("error", () => res.destroy()).pipe(res);
}
