import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import {
  LoginRateLimiter,
  clearedCookie,
  clientIp,
  isAuthed,
  passwordMatches,
  sessionCookie,
  signCookie,
  type Clock,
} from "./auth.js";
import type { HubConfig } from "./config.js";
import { defaultRuby, handleMergeMode, type RubyRunner } from "./merge-mode.js";
import { Registry } from "./registry.js";
import { BrowserRelay, MAX_BROWSER_FRAME } from "./relay.js";
import { MAX_UPLOAD_BYTES, RETENTION_DAYS, uploadConfig, type UploadConfig } from "./uploads/config.js";
import { pruneUploads } from "./uploads/retention.js";
import { handleUploads } from "./uploads/routes.js";
import { usageConfig, type UsageConfig } from "./usage/config.js";
import { handleUsage } from "./usage/routes.js";
import { UsageService, type BudgetWarning } from "./usage/service.js";
import type { FetchLike } from "./usage/openrouter.js";
import { applySecurityHeaders, isPublicPath, serveStatic } from "./static.js";

export interface HubOptions {
  config: HubConfig;
  now?: Clock;
  limiter?: LoginRateLimiter;
  log?: (line: string) => void;
  rescanMs?: number;
  uploads?: UploadConfig;
  maxUploadBytes?: number;
  usage?: UsageConfig;
  usageFetch?: FetchLike;
  onBudgetWarning?: (w: BudgetWarning) => void;
  /** cf's bin directory (default ~/.claude/cf/bin, or PORCUPINE_CF_BIN). */
  cfBin?: string;
  ruby?: RubyRunner;
}

export interface Hub {
  server: Server;
  registry: Registry;
  usage: UsageService;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

const FALLBACK_LOGIN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Porcupine login</title></head>
<body><main><h1>Porcupine</h1>
<form method="post" action="/api/login">
<label>Password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button type="submit">Log in</button></form></main></body></html>
`;

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createHub(opts: HubOptions): Hub {
  const { config } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((l: string) => console.log(l));
  const limiter = opts.limiter ?? new LoginRateLimiter({ perIp: 5, global: 20, windowMs: 15 * 60 * 1000, now });
  const secure = !config.dev;
  const relays = new Set<BrowserRelay>();
  const usage = new UsageService({
    config: opts.usage ?? usageConfig(process.env, homedir()),
    now,
    log,
    fetch: opts.usageFetch,
    onBudgetWarning: (w) => {
      log(`budget warning: ${w.provider} ${String(w.threshold)}%`);
      relays.forEach((r) => r.notice(w.threshold >= 100 ? "error" : "warn", w.text));
      opts.onBudgetWarning?.(w);
    },
  });
  const registry = new Registry({
    runtimeDir: config.runtimeDir,
    log,
    rescanMs: opts.rescanMs ?? 5000,
    onChange: () => relays.forEach((r) => r.sessionsChanged()),
    onSessionEnded: (id) => relays.forEach((r) => r.sessionEnded(id)),
    onEvent: (meta, seq, event) => {
      if (event.type === "message_end") usage.record(event.message, { sessionId: meta.id, cwd: meta.cwd, seq });
    },
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BROWSER_FRAME });
  wss.on("connection", (ws) => {
    const relay = new BrowserRelay(ws, registry);
    relays.add(relay);
    ws.on("close", () => relays.delete(relay));
  });

  const loginPage = (): string => {
    const built = join(config.webDist, "login.html");
    return existsSync(built) ? readFileSync(built, "utf8") : FALLBACK_LOGIN;
  };

  const authed = (req: IncomingMessage): boolean => isAuthed(req, config.cookieSecret, now);
  const uploads = opts.uploads ?? uploadConfig(process.env, homedir(), log);
  const uploadCtx = {
    config: uploads,
    maxBytes: opts.maxUploadBytes ?? MAX_UPLOAD_BYTES,
    origins: config.origins,
    authed,
    sessionExists: (id: string) => registry.socketPath(id) !== null,
    now,
    log,
  };
  let retentionTimer: NodeJS.Timeout | null = null;
  const prune = (): void => {
    try {
      const n = pruneUploads(uploads.root, now(), RETENTION_DAYS);
      if (n > 0) log(`uploads: pruned ${n} older than ${RETENTION_DAYS} days`);
    } catch (e) {
      log(`uploads: prune failed: ${(e as Error).message}`);
    }
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res);
    const url = new URL(req.url ?? "/", "http://hub");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/api/login" && method === "POST") {
      const ip = clientIp(req);
      if (limiter.blocked(ip)) {
        log(`login rate limited ip=${ip}`);
        res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "900" }).end("too many attempts\n");
        return;
      }
      const body = await readBody(req, 4096);
      const password = body === null ? "" : (new URLSearchParams(body).get("password") ?? "");
      if (body === null || !passwordMatches(password, config.password)) {
        limiter.fail(ip);
        log(`login failed ip=${ip}`);
        res.writeHead(303, { Location: "/login?error=1#error" }).end();
        return;
      }
      log(`login ok ip=${ip}`);
      res
        .writeHead(303, {
          Location: "/",
          "Set-Cookie": sessionCookie(signCookie(config.cookieSecret, config.cookieTtlSec, now), config.cookieTtlSec, secure),
        })
        .end();
      return;
    }
    if (path === "/api/logout" && method === "POST") {
      res.writeHead(303, { Location: "/login", "Set-Cookie": clearedCookie(secure) }).end();
      return;
    }
    if (path === "/api/me") {
      const ok = authed(req);
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ authenticated: ok }) + "\n");
      return;
    }
    if (await handleUploads(req, res, uploadCtx)) return;
    if (
      await handleMergeMode(req, res, {
        origins: config.origins,
        authed,
        sessionExists: (id) => registry.socketPath(id) !== null,
        runtimeDir: config.runtimeDir,
        cfBin: opts.cfBin ?? process.env.PORCUPINE_CF_BIN ?? join(homedir(), ".claude", "cf", "bin"),
        ruby: opts.ruby ?? defaultRuby(process.env.PORCUPINE_RUBY ?? "ruby"),
        log,
      })
    )
      return;
    if (await handleUsage(req, res, { service: usage, origins: config.origins, authed, log })) return;
    if (path.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    if (path === "/login") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(method === "HEAD" ? undefined : loginPage());
      return;
    }
    if (!isPublicPath(path) && !authed(req)) {
      res.writeHead(303, { Location: "/login" }).end();
      return;
    }
    if (!serveStatic(config.webDist, path, res, method)) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`error: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => undefined);
    const path = new URL(req.url ?? "/", "http://hub").pathname;
    if (path !== "/ws") return rejectUpgrade(socket, 404, "Not Found");
    if (!authed(req)) return rejectUpgrade(socket, 401, "Unauthorized");
    const origin = req.headers.origin;
    if (!origin || !config.origins.includes(origin)) {
      log(`ws rejected: bad origin ${origin ?? "(none)"}`);
      return rejectUpgrade(socket, 403, "Forbidden");
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  return {
    server,
    registry,
    usage,
    async listen() {
      await registry.start();
      prune();
      retentionTimer = setInterval(prune, 24 * 60 * 60 * 1000);
      retentionTimer.unref();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => resolve());
      });
      setTimeout(() => {
        usage.backfill(registry.list().map((x) => x.cwd)).catch((e: unknown) => log(`usage: backfill failed: ${(e as Error).message}`));
      }, 0).unref();
      const addr = server.address();
      return { port: typeof addr === "object" && addr ? addr.port : config.port };
    },
    async close() {
      registry.stop();
      if (retentionTimer) clearInterval(retentionTimer);
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
