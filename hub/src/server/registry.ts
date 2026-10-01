import { existsSync, readdirSync, readFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { PiEvent, SessionMeta } from "../shared/protocol.js";
import { sessionPaths } from "../shared/paths.js";
import { CliConnection } from "./cli-connection.js";

export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  model: string | null;
  isStreaming: boolean;
  /** Settled since a client last viewed it. */
  unread: boolean;
  /** An extension dialog is waiting for an answer. */
  needsInput: boolean;
  startedAt: string;
  piVersion?: string | null;
}

interface Entry {
  meta: SessionMeta;
  sock: string;
  conn: CliConnection;
  isStreaming: boolean;
  unread: boolean;
  needsInput: boolean;
}

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/** Applies one event to an entry's running/unread/needs-input state; returns what happened. */
export function applyActivity(
  e: { isStreaming: boolean; unread: boolean; needsInput: boolean },
  event: PiEvent,
  viewed: boolean,
): { changed: boolean; settled: boolean; needsInput: string | null } {
  const before = `${String(e.isStreaming)}${String(e.unread)}${String(e.needsInput)}`;
  let settled = false;
  let ask: string | null = null;
  if (event.type === "agent_start") e.isStreaming = true;
  if ((event.type === "agent_end" || event.type === "agent_settled") && e.isStreaming) {
    e.isStreaming = false;
    settled = true;
    if (!viewed) e.unread = true;
  }
  if (event.type === "agent_settled") e.needsInput = false;
  if (event.type === "porcupine_ui_resolved") e.needsInput = false;
  if (event.type === "extension_ui_request" && typeof event.method === "string" && DIALOGS.has(event.method)) {
    e.needsInput = true;
    ask = typeof event.title === "string" ? event.title : "";
  }
  return { changed: before !== `${String(e.isStreaming)}${String(e.unread)}${String(e.needsInput)}`, settled, needsInput: ask };
}

export interface RegistryOptions {
  runtimeDir: string;
  onChange?: () => void;
  onSessionEnded?: (id: string) => void;
  /** Every event frame from every session, e.g. for the usage ledger. */
  onEvent?: (meta: SessionMeta, seq: number, event: PiEvent) => void;
  /** True while some client is looking at the session (suppresses unread). */
  isViewed?: (id: string) => boolean;
  /** A run finished (agent_end/agent_settled after agent_start). */
  onSettled?: (meta: SessionMeta, viewed: boolean) => void;
  /** An extension dialog started waiting. */
  onNeedsInput?: (meta: SessionMeta, title: string, viewed: boolean) => void;
  log?: (line: string) => void;
  isAlive?: (pid: number) => boolean;
  rescanMs?: number;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Discovers CLI sessions in the runtime dir, prunes stale ones, tracks isStreaming. */
export class Registry {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<string>();
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scanning: Promise<void> | null = null;
  private rescanRequested = false;

  constructor(private readonly opts: RegistryOptions) {}

  async start(): Promise<void> {
    await this.scan();
    try {
      this.watcher = watch(this.opts.runtimeDir, () => void this.scan());
      this.watcher.on("error", () => undefined);
    } catch {
      // Directory may not exist yet; the periodic rescan covers it.
    }
    this.timer = setInterval(() => void this.scan(), this.opts.rescanMs ?? 5000);
    this.timer.unref();
  }

  stop(): void {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    for (const e of this.entries.values()) e.conn.close();
    this.entries.clear();
  }

  list(): SessionSummary[] {
    return [...this.entries.values()]
      .map(({ meta, isStreaming, unread, needsInput }) => ({
        id: meta.id,
        name: meta.name,
        cwd: meta.cwd,
        model: meta.provider && meta.model ? `${meta.provider}/${meta.model}` : meta.model,
        isStreaming,
        unread,
        needsInput,
        startedAt: meta.startedAt,
        piVersion: meta.piVersion,
      }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** A client viewed the session: clears unread. */
  markRead(id: string): void {
    const e = this.entries.get(id);
    if (e?.unread) {
      e.unread = false;
      this.opts.onChange?.();
    }
  }

  socketPath(id: string): string | null {
    return this.entries.get(id)?.sock ?? null;
  }

  /** Scans once; concurrent calls coalesce into at most one follow-up scan. */
  scan(): Promise<void> {
    if (this.scanning) {
      this.rescanRequested = true;
      return this.scanning;
    }
    this.scanning = this.doScan().finally(() => {
      this.scanning = null;
      if (this.rescanRequested) {
        this.rescanRequested = false;
        void this.scan();
      }
    });
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(this.opts.runtimeDir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    const isAlive = this.opts.isAlive ?? pidAlive;
    await Promise.all(
      names.map(async (n) => {
        const id = n.slice(0, -".json".length);
        if (this.entries.has(id) || this.pending.has(id)) return;
        const paths = sessionPaths(this.opts.runtimeDir, id);
        let meta: SessionMeta;
        try {
          meta = JSON.parse(readFileSync(join(this.opts.runtimeDir, n), "utf8")) as SessionMeta;
        } catch {
          return; // Partially written; next scan retries.
        }
        if (!isAlive(meta.pid)) return this.prune(id, "pid dead");
        if (!existsSync(paths.sock)) return this.prune(id, "socket missing");
        this.pending.add(id);
        try {
          await this.connect(id, meta, paths.sock);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "ECONNREFUSED" || code === "ENOENT") this.prune(id, code);
        } finally {
          this.pending.delete(id);
        }
      }),
    );
  }

  private prune(id: string, why: string): void {
    const p = sessionPaths(this.opts.runtimeDir, id);
    rmSync(p.sock, { force: true });
    rmSync(p.meta, { force: true });
    this.opts.log?.(`pruned stale session ${id} (${why})`);
  }

  private async connect(id: string, meta: SessionMeta, sock: string): Promise<void> {
    const entry: Omit<Entry, "conn"> & { conn?: CliConnection } = {
      meta,
      sock,
      isStreaming: false,
      unread: false,
      needsInput: false,
    };
    let ended = false;
    const conn = await CliConnection.open(sock, null, {
      onFrame: (f) => {
        if (f.t === "welcome") {
          entry.meta = f.meta;
        } else if (f.t === "event") {
          const viewed = this.opts.isViewed?.(id) ?? false;
          const r = applyActivity(entry, f.event, viewed);
          if (r.changed) this.opts.onChange?.();
          try {
            if (r.settled) this.opts.onSettled?.(entry.meta, viewed);
            if (r.needsInput !== null) this.opts.onNeedsInput?.(entry.meta, r.needsInput, viewed);
          } catch (e) {
            this.opts.log?.(`activity hook failed: ${(e as Error).message}`);
          }
          try {
            this.opts.onEvent?.(entry.meta, f.seq, f.event);
          } catch (e) {
            this.opts.log?.(`event hook failed: ${(e as Error).message}`);
          }
        } else if (f.t === "session_ended") {
          ended = true;
        }
      },
      onClose: () => {
        if (this.entries.get(id)?.conn === conn) {
          this.entries.delete(id);
          this.opts.log?.(`session ${id} ${ended ? "ended" : "disconnected"}`);
          this.opts.onSessionEnded?.(id);
          this.opts.onChange?.();
        }
      },
    });
    entry.conn = conn;
    this.entries.set(id, entry as Entry);
    this.opts.log?.(`discovered session ${id} (${meta.name})`);
    this.opts.onChange?.();
  }
}
