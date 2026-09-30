import { existsSync, readdirSync, readFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { SessionMeta } from "../shared/protocol.js";
import { sessionPaths } from "../shared/paths.js";
import { CliConnection } from "./cli-connection.js";

export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  model: string | null;
  isStreaming: boolean;
  startedAt: string;
}

interface Entry {
  meta: SessionMeta;
  sock: string;
  conn: CliConnection;
  isStreaming: boolean;
}

export interface RegistryOptions {
  runtimeDir: string;
  onChange?: () => void;
  onSessionEnded?: (id: string) => void;
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
      .map(({ meta, isStreaming }) => ({
        id: meta.id,
        name: meta.name,
        cwd: meta.cwd,
        model: meta.provider && meta.model ? `${meta.provider}/${meta.model}` : meta.model,
        isStreaming,
        startedAt: meta.startedAt,
      }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
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
    const entry: Omit<Entry, "conn"> & { conn?: CliConnection } = { meta, sock, isStreaming: false };
    let ended = false;
    const conn = await CliConnection.open(sock, null, {
      onFrame: (f) => {
        if (f.t === "welcome") {
          entry.meta = f.meta;
        } else if (f.t === "event") {
          const before = entry.isStreaming;
          if (f.event.type === "agent_start") entry.isStreaming = true;
          if (f.event.type === "agent_end" || f.event.type === "agent_settled") entry.isStreaming = false;
          if (before !== entry.isStreaming) this.opts.onChange?.();
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
