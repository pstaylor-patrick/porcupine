import { readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Removes <root>/<sid>/<uid> dirs older than `days`, then empty session dirs. Returns the count removed. */
export function pruneUploads(root: string, nowMs: number, days: number): number {
  const cutoff = nowMs - days * DAY_MS;
  let removed = 0;
  for (const sid of dirs(root)) {
    const sdir = join(root, sid);
    for (const uid of dirs(sdir)) {
      const udir = join(sdir, uid);
      try {
        if (statSync(udir).mtimeMs < cutoff) {
          rmSync(udir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // Vanished concurrently; ignore.
      }
    }
    try {
      if (readdirSync(sdir).length === 0) rmdirSync(sdir);
    } catch {
      // Not empty or already gone.
    }
  }
  return removed;
}
