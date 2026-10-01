import { fileURLToPath } from "node:url";
import { defaultEnvFile, resolveRuntimeDir } from "../shared/paths.js";
import { readEnvFile } from "./env-file.js";

export const DEFAULT_COOKIE_TTL_SEC = 30 * 24 * 60 * 60;

export interface HubConfig {
  host: string;
  port: number;
  dev: boolean;
  origins: string[];
  password: string;
  cookieSecret: string;
  cookieTtlSec: number;
  runtimeDir: string;
  webDist: string;
}

export class ConfigError extends Error {}

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

export function parseAddr(addr: string): { host: string; port: number } {
  const i = addr.lastIndexOf(":");
  const host = (i === -1 ? addr : addr.slice(0, i)).replace(/^\[|\]$/g, "") || "127.0.0.1";
  const port = i === -1 ? 8787 : Number(addr.slice(i + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`invalid PORCUPINE_HUB_ADDR: ${addr}`);
  return { host, port };
}

export interface LoadConfigInput {
  env: NodeJS.ProcessEnv;
  home?: string;
  readEnv?: (path: string) => Record<string, string>;
}

export function loadConfig(input: LoadConfigInput): HubConfig {
  const { env } = input;
  const envFile = defaultEnvFile(env, input.home);
  let secrets: Record<string, string>;
  try {
    secrets = (input.readEnv ?? readEnvFile)(envFile);
  } catch (e) {
    throw new ConfigError(`cannot read env file ${envFile}: ${(e as Error).message}`);
  }
  const { host, port } = parseAddr(env.PORCUPINE_HUB_ADDR ?? secrets.PORCUPINE_HUB_ADDR ?? "127.0.0.1:8787");
  const dev = env.PORCUPINE_DEV === "1";
  if (dev && !isLoopback(host)) {
    throw new ConfigError(`PORCUPINE_DEV is set but PORCUPINE_HUB_ADDR (${host}) is not loopback; refusing to start`);
  }
  const password = secrets.PORCUPINE_RPC_PASSWORD ?? "";
  if (!password) throw new ConfigError(`PORCUPINE_RPC_PASSWORD is missing from ${envFile}`);
  const cookieSecret = secrets.PORCUPINE_COOKIE_SECRET ?? "";
  if (cookieSecret.length < 32) {
    throw new ConfigError(
      `PORCUPINE_COOKIE_SECRET is missing or short in ${envFile}. Generate it with:\n` +
        `  echo "PORCUPINE_COOKIE_SECRET=$(openssl rand -hex 32)" >> ${envFile}`,
    );
  }
  const ttl = env.PORCUPINE_COOKIE_TTL_SEC ? Number(env.PORCUPINE_COOKIE_TTL_SEC) : DEFAULT_COOKIE_TTL_SEC;
  if (!Number.isInteger(ttl) || ttl <= 0) throw new ConfigError("invalid PORCUPINE_COOKIE_TTL_SEC");
  // The public URL browsers load the app from; WebSocket upgrades from any other origin are refused.
  const origins = (env.PORCUPINE_ORIGIN ?? secrets.PORCUPINE_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (origins.length === 0 && !dev) {
    throw new ConfigError(`PORCUPINE_ORIGIN is not set. Add the URL you open the app at to ${envFile}, e.g. PORCUPINE_ORIGIN=https://porcupine.example.com`);
  }
  if (dev) origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  return {
    host,
    port,
    dev,
    origins,
    password,
    cookieSecret,
    cookieTtlSec: ttl,
    runtimeDir: resolveRuntimeDir(input.home ? { env, home: input.home } : { env }),
    webDist: env.PORCUPINE_WEB_DIST ?? fileURLToPath(new URL("../../../web/dist", import.meta.url)),
  };
}
