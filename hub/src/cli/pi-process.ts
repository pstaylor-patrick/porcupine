import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonlSplitter, toJsonl } from "../shared/jsonl.js";
import type { PiCommand, PiEvent, PiResponse } from "../shared/protocol.js";

export const COMMAND_TIMEOUT_MS = 30_000;

export interface PiProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onEvent: (event: PiEvent) => void;
  onUiRequest: (req: PiEvent) => void;
  onStderr: (line: string) => void;
  onParseError: (line: string) => void;
  onExit: (code: number) => void;
  timeoutMs?: number;
}

interface Pending {
  resolve: (r: PiResponse) => void;
  timer: NodeJS.Timeout | null;
}

/** Wraps `pi --mode rpc`: JSONL on stdin/stdout, correlates responses by id. */
export class PiProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private counter = 0;
  private readonly pending = new Map<string, Pending>();
  private exited = false;
  readonly exitPromise: Promise<number>;

  constructor(private readonly opts: PiProcessOptions) {
    this.child = spawn(opts.bin, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    const out = new JsonlSplitter();
    const err = new JsonlSplitter();
    this.child.stdout.on("data", (c: Buffer) => out.push(c).forEach((l) => this.onLine(l)));
    this.child.stdout.on("end", () => out.end().forEach((l) => this.onLine(l)));
    this.child.stderr.on("data", (c: Buffer) => err.push(c).forEach((l) => l && opts.onStderr(l)));
    this.child.stdin.on("error", () => undefined);
    this.exitPromise = new Promise((resolve) => {
      const done = (code: number): void => {
        if (this.exited) return;
        this.exited = true;
        err.end().forEach((l) => l && opts.onStderr(l));
        for (const [, p] of this.pending) {
          if (p.timer) clearTimeout(p.timer);
          p.resolve({ success: false, error: "pi exited" });
        }
        this.pending.clear();
        opts.onExit(code);
        resolve(code);
      };
      this.child.on("exit", (code, signal) => done(code ?? (signal ? 128 + signalNumber(signal) : 1)));
      this.child.on("error", (e) => {
        opts.onStderr(`spawn failed: ${e.message}`);
        done(127);
      });
    });
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.onParseError(line);
      return;
    }
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      this.opts.onParseError(line);
      return;
    }
    const m = msg as PiEvent;
    if (m.type === "response") {
      const id = typeof m.id === "string" ? m.id : undefined;
      const p = id ? this.pending.get(id) : undefined;
      if (id && p) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.resolve(m as unknown as PiResponse);
      }
      return;
    }
    if (m.type === "extension_ui_request") {
      this.opts.onUiRequest(m);
      return;
    }
    this.opts.onEvent(m);
  }

  /** Sends a command with a fresh `p<n>` id and resolves with pi's response. */
  send(cmd: PiCommand): Promise<PiResponse> {
    if (this.exited) return Promise.resolve({ success: false, error: "pi exited" });
    const id = `p${++this.counter}`;
    return new Promise((resolve) => {
      const timeoutMs = this.opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
      const timer =
        cmd.type === "prompt"
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              resolve({ success: false, error: "timeout" });
            }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.writeRaw({ ...cmd, id });
    });
  }

  writeRaw(value: unknown): void {
    if (this.exited || this.child.stdin.destroyed) return;
    this.child.stdin.write(toJsonl(value));
  }

  closeStdin(): void {
    this.child.stdin.end();
  }

  kill(signal: NodeJS.Signals): void {
    if (!this.exited) this.child.kill(signal);
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return table[signal] ?? 0;
}
