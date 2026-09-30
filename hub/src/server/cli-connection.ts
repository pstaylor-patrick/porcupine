import { connect, type Socket } from "node:net";
import { JsonlSplitter, toJsonl } from "../shared/jsonl.js";
import { PROTOCOL_VERSION, type CliToHubFrame, type HubToCliFrame } from "../shared/protocol.js";

export interface CliConnectionHandlers {
  onFrame: (frame: CliToHubFrame) => void;
  onClose: () => void;
}

/** One hub-side connection to a CLI's Unix socket. */
export class CliConnection {
  private closed = false;

  private constructor(
    private readonly sock: Socket,
    handlers: CliConnectionHandlers,
  ) {
    const splitter = new JsonlSplitter();
    sock.on("data", (c: Buffer) => {
      for (const line of splitter.push(c)) {
        if (line.trim() === "") continue;
        try {
          handlers.onFrame(JSON.parse(line) as CliToHubFrame);
        } catch {
          // Malformed frame from the CLI: drop it.
        }
      }
    });
    sock.on("error", () => undefined);
    sock.on("close", () => {
      this.closed = true;
      handlers.onClose();
    });
  }

  /** Connects and sends hello. Rejects with the socket error (e.g. ECONNREFUSED, ENOENT). */
  static open(path: string, since: number | null, handlers: CliConnectionHandlers): Promise<CliConnection> {
    return new Promise((resolve, reject) => {
      const sock = connect(path);
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.off("error", reject);
        const conn = new CliConnection(sock, handlers);
        conn.send({ t: "hello", proto: PROTOCOL_VERSION, since });
        resolve(conn);
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(frame: HubToCliFrame): void {
    if (!this.closed) this.sock.write(toJsonl(frame));
  }

  close(): void {
    this.sock.destroy();
  }
}
