import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneUploads } from "../src/server/uploads/retention.js";

const DAY = 24 * 60 * 60 * 1000;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "porcupine-retention-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function upload(sid: string, uid: string, mtimeMs: number): string {
  const dir = join(root, sid, uid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), "{}");
  utimesSync(dir, mtimeMs / 1000, mtimeMs / 1000);
  return dir;
}

describe("pruneUploads", () => {
  it("removes dirs older than the window and empty session dirs, keeps newer ones", () => {
    const now = Date.UTC(2026, 8, 30);
    const old = upload("a", "old", now - 31 * DAY);
    const fresh = upload("a", "fresh", now - 29 * DAY);
    const lonely = upload("b", "old", now - 40 * DAY);
    expect(pruneUploads(root, now, 30)).toBe(2);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(lonely)).toBe(false);
    expect(existsSync(join(root, "b"))).toBe(false);
    expect(existsSync(join(root, "a"))).toBe(true);
  });
  it("returns 0 for a missing root", () => {
    expect(pruneUploads(join(root, "missing"), Date.now(), 30)).toBe(0);
  });
});
