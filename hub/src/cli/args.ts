import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export const DEFAULT_PROVIDER = "vercel-ai-gateway";
export const DEFAULT_MODEL = "anthropic/claude-opus-5.5";
export const DEFAULT_THINKING = "low";

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

export function buildPiArgs(userArgs: string[], extensions: string[] = []): string[] {
  const out = ["--mode", "rpc", ...extensions.flatMap((e) => ["--extension", e])];
  if (!hasFlag(userArgs, "--provider") && !hasFlag(userArgs, "--model")) {
    out.push("--provider", DEFAULT_PROVIDER, "--model", DEFAULT_MODEL);
  }
  if (!hasFlag(userArgs, "--thinking")) out.push("--thinking", DEFAULT_THINKING);
  return [...out, ...userArgs];
}

/** Child env: process env plus AI_GATEWAY_API_KEY mapping, minus porcupine secrets. */
export function buildChildEnv(processEnv: NodeJS.ProcessEnv, fileEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...processEnv };
  const key = fileEnv.VERCEL_AI_GATEWAY_API_KEY ?? processEnv.VERCEL_AI_GATEWAY_API_KEY;
  if (!env.AI_GATEWAY_API_KEY && key) env.AI_GATEWAY_API_KEY = key;
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
