/**
 * GET/POST /api/sessions/:id/merge-mode: the per-session cf merge mode,
 * read and written through cf's own Ruby (MergeModeStore, MergeModeSlug,
 * merge_mode_record.rb). Porcupine keeps no store and no default of its own:
 * an unset session shows whatever cf falls back to.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { cfIdPath } from "../shared/paths.js";

export interface MergeModeState {
  mode: string;
  /** The persisted slug, or null when cf is using its fallback. */
  stored: string | null;
  fallback: string;
  modes: string[];
}

export type RubyRunner = (args: string[], stdin: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface MergeModeContext {
  origins: string[];
  authed(req: IncomingMessage): boolean;
  sessionExists(id: string): boolean;
  runtimeDir: string;
  cfBin: string;
  ruby: RubyRunner;
  log(line: string): void;
}

const READ_SCRIPT = `
require 'json'
require File.join(ARGV[0], 'merge_mode_store')
require File.join(ARGV[0], 'merge_mode_slug')
stored = MergeModeSlug.of(MergeModeStore.new(ARGV[1]).mode)
puts JSON.generate(mode: stored || MergeModeSlug::FALLBACK, stored: stored, fallback: MergeModeSlug::FALLBACK, modes: MergeModeSlug::MODES)
`;

export function defaultRuby(bin: string): RubyRunner {
  return (args, stdin) =>
    new Promise((resolve) => {
      const child = execFile(bin, args, { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout, stderr });
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin);
    });
}

/** The session id cf knows this session by: what the claude-hooks extension recorded, else the registry id. */
export function cfSessionId(runtimeDir: string, id: string): string {
  try {
    const v = readFileSync(cfIdPath(runtimeDir, id), "utf8").trim();
    if (v) return v;
  } catch {
    // Not recorded yet (extension not loaded or session predates it).
  }
  return id;
}

export async function readMergeMode(ctx: Pick<MergeModeContext, "cfBin" | "ruby">, cfId: string): Promise<MergeModeState> {
  const r = await ctx.ruby(["-e", READ_SCRIPT, ctx.cfBin, cfId], "");
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || `ruby exited ${String(r.code)}`);
  const j = JSON.parse(r.stdout) as Partial<MergeModeState>;
  if (typeof j.mode !== "string" || typeof j.fallback !== "string" || !Array.isArray(j.modes)) throw new Error("unexpected cf output");
  return { mode: j.mode, stored: typeof j.stored === "string" ? j.stored : null, fallback: j.fallback, modes: j.modes.map(String) };
}

/** Records a mode the way /cf does: an AskUserQuestion PostToolUse event into merge_mode_record.rb. */
export async function writeMergeMode(ctx: Pick<MergeModeContext, "cfBin" | "ruby">, cfId: string, mode: string): Promise<void> {
  const question = "Which merge mode for this session?";
  const event = {
    session_id: cfId,
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_response: { questions: [{ header: "Merge mode", question }], answers: { [question]: mode } },
  };
  const r = await ctx.ruby([join(ctx.cfBin, "merge_mode_record.rb")], JSON.stringify(event));
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || `ruby exited ${String(r.code)}`);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body) + "\n");
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const ROUTE = /^\/api\/sessions\/([^/]+)\/merge-mode$/;

export async function handleMergeMode(req: IncomingMessage, res: ServerResponse, ctx: MergeModeContext): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://hub").pathname;
  const m = ROUTE.exec(path);
  if (!m) return false;
  const method = req.method ?? "GET";
  if (!ctx.authed(req)) {
    req.resume();
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  let id: string;
  try {
    id = decodeURIComponent(m[1] ?? "");
  } catch {
    id = "";
  }
  if (!id || !ctx.sessionExists(id)) {
    req.resume();
    json(res, 404, { error: "no such session" });
    return true;
  }
  const cfId = cfSessionId(ctx.runtimeDir, id);
  if (method === "GET") {
    try {
      json(res, 200, { sessionId: cfId, ...(await readMergeMode(ctx, cfId)) });
    } catch (e) {
      ctx.log(`merge-mode read failed: ${(e instanceof Error ? e.message : String(e))}`);
      json(res, 502, { error: `cf: ${(e instanceof Error ? e.message : String(e))}` });
    }
    return true;
  }
  if (method === "POST") {
    const origin = req.headers.origin;
    if (!origin || !ctx.origins.includes(origin)) {
      ctx.log(`merge-mode rejected: bad origin ${origin ?? "(none)"}`);
      req.resume();
      json(res, 403, { error: "forbidden" });
      return true;
    }
    const body = await readBody(req, 4096);
    let mode: unknown;
    try {
      mode = body === null ? undefined : (JSON.parse(body) as { mode?: unknown }).mode;
    } catch {
      mode = undefined;
    }
    if (typeof mode !== "string" || !mode) {
      json(res, 400, { error: "mode required" });
      return true;
    }
    try {
      const before = await readMergeMode(ctx, cfId);
      if (!before.modes.includes(mode)) {
        json(res, 400, { error: "unknown mode" });
        return true;
      }
      await writeMergeMode(ctx, cfId, mode);
      json(res, 200, { sessionId: cfId, ...(await readMergeMode(ctx, cfId)) });
    } catch (e) {
      ctx.log(`merge-mode write failed: ${(e instanceof Error ? e.message : String(e))}`);
      json(res, 502, { error: `cf: ${(e instanceof Error ? e.message : String(e))}` });
    }
    return true;
  }
  req.resume();
  json(res, 405, { error: "method not allowed" });
  return true;
}
