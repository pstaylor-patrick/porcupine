/** WebSocket connection to the hub: reconnect with backoff, replay cursor, ping, command correlation. */

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  model: string | null;
  isStreaming: boolean;
  /** Settled since a client last viewed it. */
  unread?: boolean;
  /** An extension dialog is waiting for an answer. */
  needsInput?: boolean;
  startedAt: string;
  piVersion?: string | null;
}

export interface PiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  command?: string;
}

export type ServerFrame =
  | { t: "sessions"; sessions: SessionInfo[] }
  | { t: "attached"; session: string; headSeq: number }
  | { t: "reset"; session: string }
  | { t: "event"; session: string; seq: number; event: Record<string, unknown> }
  | { t: "result"; cid: string; response: PiResponse }
  | { t: "session_ended"; session: string }
  | { t: "error"; message: string }
  | { t: "notice"; level: "info" | "warn" | "error"; text: string }
  | { t: "pong" };

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface Handlers {
  onFrame(frame: ServerFrame): void;
  onStatus(status: "connecting" | "open" | "closed"): void;
}

export interface ConnectionOptions {
  url: string;
  create?: (url: string) => SocketLike;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

const OPEN = 1;
const CURSOR_KEY = "porcupine.cursor";
export const PING_MS = 20_000;
export const MAX_BACKOFF_MS = 10_000;
export const COMMAND_TIMEOUT_MS = 60_000;

export function nextBackoff(current: number): number {
  return current === 0 ? 500 : Math.min(current * 2, MAX_BACKOFF_MS);
}

export class Connection {
  sessionId: string | null = null;
  lastSeq: number | null = null;
  private sock: SocketLike | null = null;
  private backoff = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private missedPongs = 0;
  private cidCounter = 0;
  private pending = new Map<string, { resolve: (r: PiResponse) => void; timer: unknown }>();
  private stopped = false;
  private readonly o: Required<Omit<ConnectionOptions, "storage">> & { storage: ConnectionOptions["storage"] };

  constructor(
    opts: ConnectionOptions,
    private readonly h: Handlers,
  ) {
    this.o = {
      url: opts.url,
      create: opts.create ?? ((u) => new WebSocket(u) as unknown as SocketLike),
      setTimeout: opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
      clearTimeout: opts.clearTimeout ?? ((t) => globalThis.clearTimeout(t as number)),
      setInterval: opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms)),
      clearInterval: opts.clearInterval ?? ((t) => globalThis.clearInterval(t as number)),
      storage: opts.storage,
    };
    this.loadCursor();
  }

  private loadCursor(): void {
    try {
      const raw = this.o.storage?.getItem(CURSOR_KEY);
      if (!raw) return;
      // Only the session survives a reload. The new page has an empty
      // transcript, so it must replay from the start, not from lastSeq.
      const c = JSON.parse(raw) as { sessionId?: unknown };
      if (typeof c.sessionId === "string") this.sessionId = c.sessionId;
    } catch {
      // storage unavailable or corrupt: start fresh
    }
  }

  private saveCursor(): void {
    try {
      if (this.sessionId) this.o.storage?.setItem(CURSOR_KEY, JSON.stringify({ sessionId: this.sessionId, lastSeq: this.lastSeq }));
      else this.o.storage?.removeItem(CURSOR_KEY);
    } catch {
      // ignore
    }
  }

  get isOpen(): boolean {
    return this.sock !== null && this.sock.readyState === OPEN;
  }

  connect(): void {
    this.stopped = false;
    if (this.sock) return;
    if (this.retryTimer !== null) {
      this.o.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.h.onStatus("connecting");
    const s = this.o.create(this.o.url);
    this.sock = s;
    s.onopen = () => {
      this.backoff = 0;
      this.missedPongs = 0;
      this.h.onStatus("open");
      this.raw({ t: "list" });
      if (!this.visible) this.raw({ t: "view", visible: false });
      if (this.sessionId) this.raw({ t: "attach", session: this.sessionId, since: this.lastSeq });
      this.pingTimer = this.o.setInterval(() => this.ping(), PING_MS);
    };
    s.onmessage = (ev) => this.receive(ev.data);
    s.onclose = () => this.dropped(s);
    s.onerror = () => s.close();
  }

  private visible = true;

  /** Tells the hub whether the page is in the foreground, so it can mark sessions read and skip pushes. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.raw({ t: "view", visible });
  }

  /** Reconnects now (visibilitychange, online), skipping any pending backoff. */
  kick(): void {
    if (this.stopped) return;
    if (this.sock && this.sock.readyState === OPEN) {
      this.ping();
      return;
    }
    if (this.sock) {
      const s = this.sock;
      this.dropped(s);
      s.close();
    }
    this.backoff = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    const s = this.sock;
    if (s) {
      this.dropped(s);
      s.close();
    }
  }

  private ping(): void {
    if (this.missedPongs >= 2) {
      const s = this.sock;
      if (s) {
        this.dropped(s);
        s.close();
      }
      return;
    }
    this.missedPongs++;
    this.raw({ t: "ping" });
  }

  private dropped(s: SocketLike): void {
    if (this.sock !== s) return;
    this.sock = null;
    if (this.pingTimer !== null) this.o.clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const [cid, p] of this.pending) {
      this.o.clearTimeout(p.timer);
      p.resolve({ success: false, error: "disconnected" });
      this.pending.delete(cid);
    }
    this.h.onStatus("closed");
    if (this.stopped) return;
    this.backoff = nextBackoff(this.backoff);
    this.retryTimer = this.o.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.backoff);
  }

  private raw(frame: unknown): boolean {
    if (!this.sock || this.sock.readyState !== OPEN) return false;
    this.sock.send(JSON.stringify(frame));
    return true;
  }

  private receive(data: unknown): void {
    let f: ServerFrame;
    try {
      f = JSON.parse(String(data)) as ServerFrame;
    } catch {
      return;
    }
    if (f.t === "pong") {
      this.missedPongs = 0;
      return;
    }
    if (f.t === "result") {
      const p = this.pending.get(f.cid);
      if (p) {
        this.o.clearTimeout(p.timer);
        this.pending.delete(f.cid);
        p.resolve(f.response);
      }
      return;
    }
    if (f.t === "event") {
      if (f.session !== this.sessionId) return;
      if (this.lastSeq !== null && f.seq <= this.lastSeq) return;
      this.lastSeq = f.seq;
      this.saveCursor();
    }
    if (f.t === "reset" && f.session !== this.sessionId) return;
    this.h.onFrame(f);
  }

  /** Attaches to a session. `since` null asks for a full reset. */
  attach(sessionId: string): void {
    if (sessionId !== this.sessionId) this.lastSeq = null;
    this.sessionId = sessionId;
    this.saveCursor();
    this.raw({ t: "attach", session: sessionId, since: this.lastSeq });
  }

  detach(): void {
    this.sessionId = null;
    this.lastSeq = null;
    this.saveCursor();
  }

  list(): void {
    this.raw({ t: "list" });
  }

  command(cmd: Record<string, unknown> & { type: string }): Promise<PiResponse> {
    const cid = `c${++this.cidCounter}`;
    return new Promise((resolve) => {
      if (!this.raw({ t: "cmd", cid, cmd })) {
        resolve({ success: false, error: "not connected" });
        return;
      }
      const timer = this.o.setTimeout(() => {
        this.pending.delete(cid);
        resolve({ success: false, error: "timeout" });
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(cid, { resolve, timer });
    });
  }
}
