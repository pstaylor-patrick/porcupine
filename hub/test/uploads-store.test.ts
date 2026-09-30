import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uploadConfig } from "../src/server/uploads/config.js";
import { classify } from "../src/server/uploads/kind.js";
import { loadUpload, sanitizeName, saveUpload, UploadError } from "../src/server/uploads/store.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "porcupine-uploads-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function body(data: string | Buffer[], headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from(typeof data === "string" ? [Buffer.from(data)] : data) as unknown as IncomingMessage;
  (r as { headers: Record<string, string> }).headers = headers;
  return r;
}

describe("sanitizeName", () => {
  it("strips paths, control chars and leading dots", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeName("..\\x\\evil.txt")).toBe("evil.txt");
    expect(sanitizeName(".hidden")).toBe("hidden");
    expect(sanitizeName("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(sanitizeName("")).toBe("upload.bin");
    expect(sanitizeName("..")).toBe("upload.bin");
    expect(sanitizeName("meta.json")).toBe("upload.bin");
    expect(sanitizeName("x".repeat(300))).toHaveLength(120);
  });
});

describe("classify", () => {
  it("maps MIME and extension to kinds", () => {
    expect(classify("a.png", "image/png")).toBe("image");
    expect(classify("memo.m4a", "application/octet-stream")).toBe("audio");
    expect(classify("x.mov", "")).toBe("video");
    expect(classify("s.pdf", "")).toBe("pdf");
    expect(classify("n.md", "")).toBe("text");
    expect(classify("z.bin", "application/octet-stream")).toBe("file");
  });
});

describe("saveUpload / loadUpload", () => {
  it("streams to disk and writes meta.json with private modes", async () => {
    const saved = await saveUpload(body("hello world", { "content-type": "text/plain" }), root, "sess-1", "../../etc/passwd", 1024, () => 0);
    expect(saved.name).toBe("passwd");
    expect(saved.path).toBe(join(root, "sess-1", saved.id, "passwd"));
    expect(readFileSync(saved.path, "utf8")).toBe("hello world");
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    expect(statSync(saved.dir).mode & 0o777).toBe(0o700);
    const meta = JSON.parse(readFileSync(join(saved.dir, "meta.json"), "utf8")) as Record<string, unknown>;
    expect(meta).toEqual({ id: saved.id, sessionId: "sess-1", name: "passwd", mime: "text/plain", size: 11, kind: "text", createdAt: "1970-01-01T00:00:00.000Z" });
    expect((await loadUpload(root, "sess-1", saved.id))?.path).toBe(saved.path);
  });

  it("gives 413 over the cap while streaming and leaves no dir", async () => {
    const chunks = Array.from({ length: 8 }, () => Buffer.alloc(200, 1));
    await expect(saveUpload(body(chunks), root, "sess-1", "big.bin", 1000)).rejects.toMatchObject({ status: 413 });
    expect(readdirSync(join(root, "sess-1"))).toEqual([]);
  });

  it("gives 413 up front when Content-Length exceeds the cap", async () => {
    const e = await saveUpload(body("x", { "content-length": "5000" }), root, "sess-1", "a", 1000).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UploadError);
    expect((e as UploadError).status).toBe(413);
    expect(existsSync(join(root, "sess-1"))).toBe(false);
  });

  it("rejects bad session and upload ids", async () => {
    await expect(saveUpload(body("x"), root, "../x", "a", 10)).rejects.toMatchObject({ status: 400 });
    await expect(saveUpload(body("x"), root, "..", "a", 10)).rejects.toMatchObject({ status: 400 });
    expect(await loadUpload(root, "sess-1", "../../etc")).toBeNull();
    expect(await loadUpload(root, "sess-1", "not-a-uuid")).toBeNull();
    expect(await loadUpload(root, "sess-1", "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("uploadConfig", () => {
  it("uses defaults, XDG_DATA_HOME, and falls back on invalid thresholds", () => {
    const logs: string[] = [];
    const d = uploadConfig({}, "/home/u");
    expect(d).toEqual({ root: "/home/u/.local/share/porcupine/uploads", confirmUsd: 0.5, confirmMinutes: 10, whisperBin: null, whisperModel: null });
    const x = uploadConfig({ XDG_DATA_HOME: "/data", PORCUPINE_CONFIRM_USD: "-1", PORCUPINE_CONFIRM_MINUTES: "abc" }, "/home/u", (l) => logs.push(l));
    expect(x.root).toBe("/data/porcupine/uploads");
    expect(x.confirmUsd).toBe(0.5);
    expect(x.confirmMinutes).toBe(10);
    expect(logs).toHaveLength(2);
  });
});
