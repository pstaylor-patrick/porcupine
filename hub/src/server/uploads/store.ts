import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { classify, type Kind } from "./kind.js";

export interface UploadMeta {
  id: string;
  sessionId: string;
  name: string;
  mime: string;
  size: number;
  kind: Kind;
  createdAt: string;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_RE = /^[A-Za-z0-9._-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NAME = 120;

export function validSessionId(id: string): boolean {
  return SESSION_RE.test(id) && id !== "." && id !== "..";
}

export function validUploadId(id: string): boolean {
  return UUID_RE.test(id);
}

/** Reduces a client-supplied file name to a safe single path segment. */
export function sanitizeName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim().slice(0, MAX_NAME);
  return clean === "" || clean === "meta.json" ? "upload.bin" : clean;
}

function byteCap(maxBytes: number): Transform & { count: () => number } {
  let seen = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) cb(new UploadError(413, `upload exceeds ${maxBytes} bytes`));
      else cb(null, chunk);
    },
  });
  return Object.assign(t, { count: () => seen });
}

/** Streams the request body to <root>/<sessionId>/<uuid>/<name>; removes the dir on any failure. */
export async function saveUpload(
  req: IncomingMessage,
  root: string,
  sessionId: string,
  rawName: string,
  maxBytes: number,
  now: () => number = Date.now,
): Promise<UploadMeta & { dir: string; path: string }> {
  if (!validSessionId(sessionId)) throw new UploadError(400, "bad session id");
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new UploadError(413, `upload exceeds ${maxBytes} bytes`);
  const id = randomUUID();
  const name = sanitizeName(rawName);
  const dir = join(root, sessionId, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const cap = byteCap(maxBytes);
  try {
    await pipeline(req, cap, createWriteStream(path, { mode: 0o600, flags: "wx" }));
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    if (e instanceof UploadError) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") throw new UploadError(507, "disk full");
    throw new UploadError(400, "upload aborted");
  }
  const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]?.trim() || "application/octet-stream";
  const meta: UploadMeta = {
    id,
    sessionId,
    name,
    mime,
    size: cap.count(),
    kind: classify(name, mime),
    createdAt: new Date(now()).toISOString(),
  };
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  return { ...meta, dir, path };
}

/** Loads an upload's meta by validated ids only; returns null when missing or invalid. */
export async function loadUpload(
  root: string,
  sessionId: string,
  id: string,
): Promise<(UploadMeta & { dir: string; path: string }) | null> {
  if (!validSessionId(sessionId) || !validUploadId(id)) return null;
  const dir = join(root, sessionId, id);
  try {
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as UploadMeta;
    if (meta.id !== id || meta.sessionId !== sessionId) return null;
    return { ...meta, dir, path: join(dir, sanitizeName(meta.name)) };
  } catch {
    return null;
  }
}
