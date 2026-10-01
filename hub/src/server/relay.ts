import type { WebSocket, RawData } from "ws";
import type { PiCommand } from "../shared/protocol.js";
import { CliConnection } from "./cli-connection.js";
import type { Registry } from "./registry.js";

export const MAX_BROWSER_FRAME = 1024 * 1024;

type BrowserFrame =
  | { t: "list" }
  | { t: "ping" }
  | { t: "view"; visible: boolean }
  | { t: "attach"; session: string; since: number | null }
  | { t: "cmd"; cid: string; cmd: PiCommand };

function parseFrame(data: RawData): BrowserFrame | null {
  try {
    const f = JSON.parse(data.toString()) as Record<string, unknown>;
    if (f.t === "list" || f.t === "ping") return f as BrowserFrame;
    if (f.t === "view" && typeof f.visible === "boolean") return { t: "view", visible: f.visible };
    if (f.t === "attach" && typeof f.session === "string") {
      return { t: "attach", session: f.session, since: typeof f.since === "number" ? f.since : null };
    }
    if (f.t === "cmd" && typeof f.cid === "string" && f.cmd && typeof f.cmd === "object") {
      return { t: "cmd", cid: f.cid, cmd: f.cmd as PiCommand };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Bridges one browser WebSocket to at most one attached CLI session. Buffers nothing. */
export class BrowserRelay {
  private conn: CliConnection | null = null;
  private session: string | null = null;
  private attachSeq = 0;
  /** The page is in the foreground; set by the browser's "view" frames. */
  private visible = true;

  constructor(
    private readonly ws: WebSocket,
    private readonly registry: Registry,
  ) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return this.send({ t: "error", message: "binary frames not supported" });
      void this.onFrame(data);
    });
    ws.on("close", () => this.detach());
    ws.on("error", () => undefined);
  }

  send(frame: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(frame));
  }

  /** True when this browser has `id` attached and in the foreground. */
  viewing(id: string): boolean {
    return this.visible && this.session === id;
  }

  sessionsChanged(): void {
    this.send({ t: "sessions", sessions: this.registry.list() });
  }

  /** Hub-originated notice shown in every attached app (budget warnings). */
  notice(level: "info" | "warn" | "error", text: string): void {
    this.send({ t: "notice", level, text });
  }

  sessionEnded(id: string): void {
    if (this.session === id) {
      this.send({ t: "session_ended", session: id });
      this.detach();
    }
  }

  private detach(): void {
    this.attachSeq++;
    this.conn?.close();
    this.conn = null;
    this.session = null;
  }

  private async onFrame(data: RawData): Promise<void> {
    const f = parseFrame(data);
    if (!f) return this.send({ t: "error", message: "invalid frame" });
    switch (f.t) {
      case "ping":
        return this.send({ t: "pong" });
      case "list":
        return this.sessionsChanged();
      case "view":
        this.visible = f.visible;
        if (f.visible && this.session) this.registry.markRead(this.session);
        return;
      case "cmd":
        if (!this.conn) return this.send({ t: "result", cid: f.cid, response: { success: false, error: "not attached" } });
        return this.conn.send({ t: "cmd", cid: f.cid, cmd: f.cmd });
      case "attach":
        return this.attach(f.session, f.since);
    }
  }

  private async attach(id: string, since: number | null): Promise<void> {
    this.detach();
    const mine = this.attachSeq;
    const sock = this.registry.socketPath(id);
    if (!sock) return this.send({ t: "error", message: `unknown session ${id}` });
    let conn: CliConnection;
    try {
      conn = await CliConnection.open(sock, since, {
        onFrame: (fr) => {
          if (this.conn !== conn) return;
          switch (fr.t) {
            case "welcome":
              return this.send({ t: "attached", session: id, headSeq: fr.headSeq });
            case "reset":
              return this.send({ t: "reset", session: id });
            case "event":
              return this.send({ t: "event", session: id, seq: fr.seq, event: fr.event });
            case "result":
              return this.send({ t: "result", cid: fr.cid, response: fr.response });
            case "session_ended":
              return this.sessionEnded(id);
            case "error":
              return this.send({ t: "error", message: fr.message });
          }
        },
        onClose: () => {
          if (this.conn === conn) this.sessionEnded(id);
        },
      });
    } catch (e) {
      if (mine === this.attachSeq) this.send({ t: "error", message: `attach failed: ${(e as Error).message}` });
      return;
    }
    if (mine !== this.attachSeq || this.ws.readyState !== this.ws.OPEN) {
      conn.close();
      return;
    }
    this.conn = conn;
    this.session = id;
    if (this.visible) this.registry.markRead(id);
  }
}
