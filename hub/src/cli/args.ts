import { execFileSync } from "node:child_process";
import { basename } from "node:path";

import { routeProvider, vendorOfId } from "./routing.js";

/** Default model on OpenRouter, and the same model on the Anthropic API when keyed. */
export const DEFAULT_PROVIDER = "openrouter";
/** OpenRouter default while no Anthropic key is set. */
export const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";
export const DIRECT_ANTHROPIC_MODEL = "claude-opus-5-5";
export const DEFAULT_THINKING = "low";

const OPENROUTER_KEY_PREFIX = "sk-or-";

export interface PiDefaults {
  provider: string;
  model: string;
}

/** Keys that must never reach the pi child. */
export const SECRET_KEYS = ["PORCUPINE_RPC_PASSWORD", "PORCUPINE_COOKIE_SECRET"] as const;

export interface CliArgs {
  name: string | null;
  piArgs: string[];
}

/** `porcupine [--name NAME] [--] [pi args...]`. Everything that is not --name goes to pi. */
export function parseCliArgs(argv: string[]): CliArgs {
  let name: string | null = null;
  const piArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      piArgs.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--name") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("--name needs a value");
      name = v;
      i++;
    } else if (a.startsWith("--name=")) {
      name = a.slice("--name=".length);
    } else {
      piArgs.push(a);
    }
  }
  return { name, piArgs };
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/**
 * Default model from the child env. PORCUPINE_MODEL is an OpenRouter-style "vendor/model" id,
 * routed like any other; a directly served vendor gets the id without its prefix.
 */
export function resolveDefaults(env: NodeJS.ProcessEnv): PiDefaults {
  if (env.PORCUPINE_MODEL) {
    const vendor = vendorOfId(env.PORCUPINE_MODEL);
    const provider = routeProvider(vendor, env);
    if (provider) {
      const model = provider === "openrouter" ? env.PORCUPINE_MODEL : env.PORCUPINE_MODEL.slice(vendor.length + 1);
      return { provider, model };
    }
  }
  if (routeProvider("anthropic", env) === "anthropic") return { provider: "anthropic", model: DIRECT_ANTHROPIC_MODEL };
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

export function buildPiArgs(
  userArgs: string[],
  extensions: string[] = [],
  defaults: PiDefaults = { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
): string[] {
  const out = ["--mode", "rpc", ...extensions.flatMap((e) => ["--extension", e])];
  if (!hasFlag(userArgs, "--provider") && !hasFlag(userArgs, "--model")) {
    out.push("--provider", defaults.provider, "--model", defaults.model);
  }
  if (!hasFlag(userArgs, "--thinking")) out.push("--thinking", DEFAULT_THINKING);
  return [...out, ...userArgs];
}

/** Provider keys passed from the env file to pi; a key already in the process env wins. */
const PROVIDER_KEYS = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/** Keys pi would use for providers porcupine does not route to. */
const UNUSED_KEYS = ["AI_GATEWAY_API_KEY"] as const;

/** Child env: process env plus provider keys from the env file, minus porcupine secrets. */
export function buildChildEnv(processEnv: NodeJS.ProcessEnv, fileEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...processEnv };
  for (const k of PROVIDER_KEYS) {
    const v = fileEnv[k];
    if (!env[k] && v) env[k] = v;
  }
  for (const k of UNUSED_KEYS) delete env[k];
  // An OpenRouter key under OPENAI_API_KEY would be sent to OpenAI by pi: move it, never pass it on.
  for (const v of [env.OPENAI_API_KEY, fileEnv.OPENAI_API_KEY]) {
    if (v?.startsWith(OPENROUTER_KEY_PREFIX) && !env.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = v;
  }
  if (env.OPENAI_API_KEY?.startsWith(OPENROUTER_KEY_PREFIX)) {
    const fileKey = fileEnv.OPENAI_API_KEY;
    if (fileKey && !fileKey.startsWith(OPENROUTER_KEY_PREFIX)) env.OPENAI_API_KEY = fileKey;
    else delete env.OPENAI_API_KEY;
  }
  for (const k of SECRET_KEYS) delete env[k];
  return env;
}

export interface NameInput {
  explicit: string | null;
  env: NodeJS.ProcessEnv;
  cwd: string;
  tmuxName?: () => string | null;
}

function tmuxDisplayName(): string | null {
  try {
    const out = execFileSync("tmux", ["display-message", "-p", "#S:#W"], { encoding: "utf8", timeout: 2000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function resolveName(input: NameInput): string {
  if (input.explicit) return input.explicit;
  if (input.env.TMUX) {
    const t = (input.tmuxName ?? tmuxDisplayName)();
    if (t) return t;
  }
  return basename(input.cwd) || "root";
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "session";
}

/** Reads a dotenv file (KEY=VALUE, # comments, optional quotes). Missing file yields {}. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = (m[2] as string).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1] as string] = v;
  }
  return out;
}
