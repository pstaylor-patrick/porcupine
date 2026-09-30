import { createServer, type Server, type Socket } from "node:net";
import { JsonlSplitter, toJsonl } from "../shared/jsonl.js";
import {
  PROTOCOL_VERSION,
  isAllowedCommand,
  type CliToHubFrame,
  type PiCommand,
  type PiResponse,
  type SessionMeta,
} from "../shared/protocol.js";
import type { EventLog } from "./event-log.js";

export interface SocketServerOptions {
  path: string;
  log: EventLog;
  meta: () => SessionMeta;
  send: (cmd: PiCommand) => Promise<PiResponse>;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

/** Unix socket server speaking the hub<->CLI JSONL protocol. */
export class SocketServer {
  private readonly server: Server;
  private readonly attached = new Set<Socket>();
  private readonly sockets = new Set<Socket>();

  constructor(private readonly opts: SocketServerOptions) {
    this.server = createServer((sock) => this.onConnection(sock));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.path, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  private write(sock: Socket, frame: CliToHubFrame): void {
    if (!sock.destroyed) sock.write(toJsonl(frame));
  }

  private onConnection(sock: Socket): void {
    this.sockets.add(sock);
    this.opts.onConnect?.();
    const splitter = new JsonlSplitter();
    sock.on("data", (c: Buffer) => splitter.push(c).forEach((l) => this.onLine(sock, l)));
    sock.on("error", () => undefined);
    sock.on("close", () => {
      this.sockets.delete(sock);
      this.attached.delete(sock);
      this.opts.onDisconnect?.();
    });
  }

  private onLine(sock: Socket, line: string): void {
    if (line.trim() === "") return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.write(sock, { t: "error", message: "invalid json" });
      return;
    }
    const f = frame as { t?: unknown; since?: unknown; cid?: unknown; cmd?: unknown };
    if (f.t === "hello") {
      const since = typeof f.since === "number" ? f.since : null;
      const { log } = this.opts;
      this.write(sock, {
        t: "welcome",
        proto: PROTOCOL_VERSION,
        meta: this.opts.meta(),
        headSeq: log.headSeq,
        oldestSeq: log.oldestSeq,
      });
      const replay = log.since(since);
      if (replay.reset) this.write(sock, { t: "reset" });
      for (const e of replay.entries) this.write(sock, { t: "event", seq: e.seq, event: e.event });
      this.attached.add(sock);
      return;
    }
    if (f.t === "cmd" && typeof f.cid === "string") {
      const cid = f.cid;
      const cmd = f.cmd as PiCommand | undefined;
      if (!cmd || typeof cmd !== "object" || !isAllowedCommand(cmd.type)) {
        this.write(sock, { t: "result", cid, response: { success: false, error: "command not allowed" } });
        return;
      }
      // Strip any client-supplied id: the CLI owns pi ids. A dialog answer's id
      // names the dialog instead, and the session checks it against open ones.
      const { id: _ignored, ...rest } = cmd as PiCommand & { id?: unknown };
      void _ignored;
      const outgoing = cmd.type === "extension_ui_response" ? cmd : (rest as PiCommand);
      void this.opts.send(outgoing).then((response) => this.write(sock, { t: "result", cid, response }));
      return;
    }
    this.write(sock, { t: "error", message: "unknown frame" });
  }

  broadcast(frame: CliToHubFrame): void {
    for (const s of this.attached) this.write(s, frame);
  }

  get attachedCount(): number {
    return this.attached.size;
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.end();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      for (const s of this.sockets) s.destroy();
    });
  }
}
