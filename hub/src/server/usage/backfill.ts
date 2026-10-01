import { createReadStream, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { rowFromMessage, type UsageLedger } from "./ledger.js";

/**
 * One-time import of assistant usage from pi's session files. pi sessions carry no
 * porcupine marker, so a session counts when its header cwd is one porcupine has served.
 */
export async function backfill(opts: {
  ledger: UsageLedger;
  piSessionsDir: string;
  marker: string;
  cwds: Set<string>;
  log: (l: string) => void;
}): Promise<number> {
  if (existsSync(opts.marker)) return 0;
  let added = 0;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(opts.piSessionsDir);
  } catch {
    // no pi history
  }
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(opts.piSessionsDir, d)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) added += await importFile(join(opts.piSessionsDir, d, f), opts);
  }
  writeFileSync(opts.marker, `${new Date().toISOString()} ${String(added)}\n`, { mode: 0o600 });
  if (added > 0) opts.log(`usage: backfilled ${String(added)} rows`);
  return added;
}

async function importFile(file: string, opts: { ledger: UsageLedger; cwds: Set<string> }): Promise<number> {
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  let piSessionId: string | null = null;
  let cwd: string | null = null;
  let added = 0;
  let i = 0;
  for await (const line of rl) {
    i++;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type === "session") {
      piSessionId = typeof e.id === "string" ? e.id : null;
      cwd = typeof e.cwd === "string" ? e.cwd : null;
      if (!cwd || !opts.cwds.has(cwd)) {
        rl.close();
        return 0;
      }
      continue;
    }
    if (e.type !== "message" || !cwd) continue;
    const row = rowFromMessage(e.message, {
      sessionId: piSessionId ?? file,
      piSessionId,
      cwd,
      fallbackId: `${piSessionId ?? file}:${typeof e.id === "string" ? e.id : String(i)}`,
    });
    if (row && opts.ledger.append(row)) added++;
  }
  return added;
}
