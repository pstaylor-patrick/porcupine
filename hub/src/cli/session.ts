import { execFile } from "node:child_process";
import { rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import type { PiCommand, PiEvent, PiResponse, PorcupineUiResolved, SessionMeta } from "../shared/protocol.js";
import { ensureRuntimeDir, sessionPaths } from "../shared/paths.js";
import { EventLog, type EventLogLimits } from "./event-log.js";
import type { LogFn } from "./log.js";
import { PiProcess } from "./pi-process.js";
import { SocketServer } from "./socket-server.js";
import { handleUiRequest } from "./ui-autocancel.js";
import { slugify } from "./args.js";

export interface SessionOptions {
  name: string;
  cwd: string;
  piBin: string;
  piArgs: string[];
  childEnv: NodeJS.ProcessEnv;
  runtimeDir: string;
  log: LogFn;
  limits?: EventLogLimits;
  pid?: number;
  now?: () => Date;
  expectedPiVersion?: string | null;
  stdinGraceMs?: number;
  termGraceMs?: number;
}

export interface Session {
  meta: SessionMeta;
  paths: { sock: string; meta: string };
  events: EventLog;
  pi: PiProcess;
  /** Resolves with the exit code once pi has exited and files are removed. */
  done: Promise<number>;
  shutdown: () => Promise<number>;
  /** Synchronously removes the .sock and .json; safe to call more than once. */
  cleanup: () => void;
}

function piVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { env, timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim().split("\n").pop()?.trim() || null);
    });
  });
}

export async function startSession(o: SessionOptions): Promise<Session> {
  const pid = o.pid ?? process.pid;
  const id = `${slugify(o.name)}-${pid}`;
  ensureRuntimeDir(o.runtimeDir);
  const paths = sessionPaths(o.runtimeDir, id);
  const events = new EventLog(o.limits);
  const version = await piVersion(o.piBin, o.childEnv);
  if (o.expectedPiVersion && version !== o.expectedPiVersion) {
    o.log(`warning: pi version ${version ?? "unknown"} differs from pinned ${o.expectedPiVersion}`);
  }

  const meta: SessionMeta = {
    id,
    name: o.name,
    cwd: o.cwd,
    pid,
    piPid: -1,
    startedAt: (o.now ?? (() => new Date()))().toISOString(),
    piVersion: version,
    provider: null,
    model: null,
  };

  let server: SocketServer | null = null;
  const publish = (event: PiEvent): void => {
    const entry = events.append(event);
    server?.broadcast({ t: "event", seq: entry.seq, event: entry.event });
  };

  // Dialog ids forwarded to the browser and not yet answered.
  const pendingDialogs = new Set<string>();
  const resolveDialog = (id: string): void => {
    pendingDialogs.delete(id);
    const resolved: PorcupineUiResolved = { type: "porcupine_ui_resolved", id };
    publish(resolved as unknown as PiEvent);
  };

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSync(paths.sock, { force: true });
    rmSync(paths.meta, { force: true });
  };

  const pi = new PiProcess({
    bin: o.piBin,
    args: o.piArgs,
    cwd: o.cwd,
    env: o.childEnv,
    onEvent: (e) => {
      if (e.type === "agent_start") o.log("run started");
      if (e.type === "agent_settled") o.log("run settled");
      publish(e);
      // Pi resolves a dialog itself on timeout or abort; the run settling means none is still open.
      if (e.type === "agent_settled") for (const id of [...pendingDialogs]) resolveDialog(id);
    },
    onUiRequest: (req) => {
      const d = handleUiRequest(req, { browserAttached: (server?.attachedCount ?? 0) > 0 });
      if (d.forward) pendingDialogs.add(d.forward);
      if (d.response) pi.writeRaw(d.response);
      if (d.event) publish(d.event);
      if (d.log) o.log(d.log);
    },
    onStderr: (l) => o.log(`pi: ${l}`),
    onParseError: (l) => o.log(`error: dropped unparseable pi line: ${l.slice(0, 200)}`),
    onExit: () => undefined,
  });
  meta.piPid = pi.pid;

  const done = pi.exitPromise.then(async (code) => {
    o.log(`pi exited code=${code}`);
    server?.broadcast({ t: "session_ended", code });
    await server?.close();
    cleanup();
    return code;
  });

  let shuttingDown: Promise<number> | null = null;
  const shutdown = (): Promise<number> => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      if (!pi.hasExited) {
        pi.closeStdin();
        const stdinGrace = o.stdinGraceMs ?? 5000;
        const termGrace = o.termGraceMs ?? 2000;
        const t1 = setTimeout(() => pi.kill("SIGTERM"), stdinGrace);
        const t2 = setTimeout(() => pi.kill("SIGKILL"), stdinGrace + termGrace);
        await pi.exitPromise;
        clearTimeout(t1);
        clearTimeout(t2);
      }
      return done;
    })();
    return shuttingDown;
  };

  // Pi has no response for extension_ui_response, so answer the browser here.
  const answerDialog = (cmd: PiCommand): Promise<PiResponse> => {
    const reply = uiResponse(cmd);
    if (!reply || !pendingDialogs.has(reply.id)) return Promise.resolve({ success: false, error: "no such dialog" });
    pi.writeRaw(reply);
    resolveDialog(reply.id);
    return Promise.resolve({ success: true });
  };

  try {
    if (existsSync(paths.sock)) rmSync(paths.sock);
    server = new SocketServer({
      path: paths.sock,
      log: events,
      meta: () => meta,
      send: (cmd) => (cmd.type === "extension_ui_response" ? answerDialog(cmd) : pi.send(cmd)),
      onConnect: () => o.log("hub connected"),
      onDisconnect: () => o.log("hub disconnected"),
    });
    await server.listen();
    chmodSync(paths.sock, 0o600);

    const state = await pi.send({ type: "get_state" });
    if (state.success) {
      const model = (state.data as { model?: { provider?: string; id?: string } } | undefined)?.model;
      meta.provider = model?.provider ?? null;
      meta.model = model?.id ?? null;
    } else {
      o.log(`error: get_state failed: ${state.error ?? "unknown"}`);
    }
    writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    if (!pi.hasExited) o.log(`registered ${o.name} ${o.cwd} model=${meta.provider ?? "?"}/${meta.model ?? "?"}`);
  } catch (e) {
    o.log(`error: ${(e as Error).message}`);
    await shutdown();
    cleanup();
    throw e;
  }

  return { meta, paths, events, pi, done, shutdown, cleanup };
}

type UiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

/** Rebuilds a browser's answer with only the fields pi documents (rpc-extension-ui.md). */
export function uiResponse(cmd: PiCommand): UiResponse | null {
  const { id, value, confirmed, cancelled } = cmd;
  if (typeof id !== "string" || !id) return null;
  if (cancelled === true) return { type: "extension_ui_response", id, cancelled: true };
  if (typeof value === "string") return { type: "extension_ui_response", id, value };
  if (typeof confirmed === "boolean") return { type: "extension_ui_response", id, confirmed };
  return null;
}

export function readPinnedPiVersion(packageJsonUrl: URL): string | null {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { porcupine?: { piVersion?: string } };
    return pkg.porcupine?.piVersion ?? null;
  } catch {
    return null;
  }
}
