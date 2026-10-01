/**
 * Porcupine-specific pieces of the subagent extension: which provider and
 * model a child runs on, its argv and its env. Pure, so it is unit-tested
 * apart from the vendored tool.
 */
import { SECRET_KEYS } from "../../cli/args.js";
import { allowedModel, routeProvider, vendorOfId, type ModelRef } from "../../cli/routing.js";

/** The key each provider needs; a child gets only its own. */
export const PROVIDER_KEY: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const PROVIDERS = new Set(Object.keys(PROVIDER_KEY));

export type ChildModel = { ok: true; model: ModelRef } | { ok: false; error: string };

/**
 * Resolves an agent's `model:` (or the parent's model when absent) through
 * porcupine's routing rules: Anthropic and OpenAI only direct and only with
 * their key, every other vendor via OpenRouter.
 *
 * Accepted spellings: "provider/id" with provider anthropic|openai|openrouter,
 * "vendor/model" (routed like PORCUPINE_MODEL), or a bare id on the parent's
 * provider.
 */
export function resolveChildModel(spec: string | undefined, parent: ModelRef | undefined, env: NodeJS.ProcessEnv): ChildModel {
  let ref: ModelRef | null;
  const s = spec?.trim();
  if (!s) {
    if (!parent) return { ok: false, error: "no model: the agent sets none and the parent model is unknown" };
    ref = parent;
  } else {
    const prefix = vendorOfId(s);
    if (PROVIDERS.has(prefix)) ref = { provider: prefix, id: s.slice(prefix.length + 1) };
    else if (prefix) {
      const provider = routeProvider(prefix, env);
      ref = provider === null ? null : { provider, id: provider === "openrouter" ? s : s.slice(prefix.length + 1) };
    } else if (parent) ref = { provider: parent.provider, id: s };
    else ref = null;
    if (!ref) return { ok: false, error: `model not available: ${s}` };
  }
  if (!allowedModel(ref, env)) return { ok: false, error: `model not available: ${ref.provider}/${ref.id}` };
  return { ok: true, model: ref };
}

/**
 * Child env: the parent's env without porcupine secrets and without provider
 * keys the child does not use; carries the parent's cf session id so the
 * claude-hooks bridge in the child applies the parent's merge mode.
 */
export function buildSubagentEnv(env: NodeJS.ProcessEnv, provider: string, cfSessionId: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of SECRET_KEYS) delete out[k];
  const keep = PROVIDER_KEY[provider];
  for (const k of Object.values(PROVIDER_KEY)) if (k !== keep) delete out[k];
  out.PORCUPINE_CF_SESSION_ID = cfSessionId;
  out.PORCUPINE_SUBAGENT = "1";
  return out;
}

export interface ChildArgsInput {
  model: ModelRef;
  thinking?: string | undefined;
  tools?: string[] | undefined;
  extensions: string[];
  systemPromptFile?: string | undefined;
  task: string;
}

export function buildSubagentArgs(i: ChildArgsInput): string[] {
  const args = ["--mode", "json", "-p", "--no-session"];
  for (const e of i.extensions) args.push("--extension", e);
  args.push("--provider", i.model.provider, "--model", i.model.id);
  if (i.thinking) args.push("--thinking", i.thinking);
  if (i.tools && i.tools.length > 0) args.push("--tools", i.tools.join(","));
  if (i.systemPromptFile) args.push("--append-system-prompt", i.systemPromptFile);
  args.push(`Task: ${i.task}`);
  return args;
}
