import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/** Fallback provider when no override and no OpenRouter key is present. */
export const DEFAULT_PROVIDER = "vercel-ai-gateway";
export const DEFAULT_MODEL = "anthropic/claude-opus-5.5";
export const DEFAULT_THINKING = "low";

/** Providers porcupine knows how to key, with display labels. */
export const PROVIDERS: Readonly<Record<string, string>> = {
  openrouter: "OpenRouter",
  "vercel-ai-gateway": "Vercel AI Gateway",
};

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

/** Provider from the child env: PORCUPINE_PROVIDER, else openrouter when keyed, else vercel-ai-gateway. */
export function resolveDefaultProvider(env: NodeJS.ProcessEnv): string {
  if (env.PORCUPINE_PROVIDER) return env.PORCUPINE_PROVIDER;
  if (env.OPENROUTER_API_KEY) return "openrouter";
  return DEFAULT_PROVIDER;
}

export function resolveDefaults(env: NodeJS.ProcessEnv): PiDefaults {
  return { provider: resolveDefaultProvider(env), model: env.PORCUPINE_MODEL || DEFAULT_MODEL };
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

/** Child env: process env plus provider keys from the env file, minus porcupine secrets. */
export function buildChildEnv(processEnv: NodeJS.ProcessEnv, fileEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...processEnv };
  const key = fileEnv.VERCEL_AI_GATEWAY_API_KEY ?? processEnv.VERCEL_AI_GATEWAY_API_KEY;
  if (!env.AI_GATEWAY_API_KEY && key) env.AI_GATEWAY_API_KEY = key;
  const orKey = fileEnv.OPENROUTER_API_KEY ?? processEnv.OPENROUTER_API_KEY;
  if (!env.OPENROUTER_API_KEY && orKey) env.OPENROUTER_API_KEY = orKey;
  // An OpenRouter key under OPENAI_API_KEY would be sent to OpenAI by pi: move it, never pass it on.
  const openaiKey = fileEnv.OPENAI_API_KEY ?? env.OPENAI_API_KEY;
  if (openaiKey?.startsWith(OPENROUTER_KEY_PREFIX) && !env.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = openaiKey;
  if (env.OPENAI_API_KEY?.startsWith(OPENROUTER_KEY_PREFIX)) delete env.OPENAI_API_KEY;
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
