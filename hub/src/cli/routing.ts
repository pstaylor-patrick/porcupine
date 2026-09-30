import type { PiCommand, PiResponse } from "../shared/protocol.js";

/**
 * Each model has exactly one provider: Anthropic models come from the Anthropic API and
 * OpenAI models from the OpenAI API when their keys are set; everything else, and those
 * vendors while their key is missing, comes from OpenRouter. No other provider is used.
 */
const DIRECT: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export interface ModelRef {
  provider: string;
  id: string;
}

/** The provider that serves `vendor`'s models. */
export function routeProvider(vendor: string, env: NodeJS.ProcessEnv): string {
  const key = DIRECT[vendor];
  return key && env[key] ? vendor : "openrouter";
}

/** Vendor of a model id: the prefix before the first slash, or "" without one. */
export function vendorOfId(id: string): string {
  const i = id.indexOf("/");
  return i > 0 ? id.slice(0, i) : "";
}

export function allowedModel(m: ModelRef, env: NodeJS.ProcessEnv): boolean {
  const key = DIRECT[m.provider];
  if (key) return Boolean(env[key]);
  if (m.provider === "openrouter") return routeProvider(vendorOfId(m.id), env) === "openrouter";
  return false;
}

/** Drops disallowed models from a get_available_models response. */
export function filterModelsResponse(r: PiResponse, env: NodeJS.ProcessEnv): PiResponse {
  const models = (r.data as { models?: unknown } | undefined)?.models;
  if (!r.success || !Array.isArray(models)) return r;
  const kept = models.filter((m: unknown) => {
    const { provider, id } = (m ?? {}) as { provider?: unknown; id?: unknown };
    return typeof provider === "string" && typeof id === "string" && allowedModel({ provider, id }, env);
  });
  return { ...r, data: { ...(r.data as object), models: kept } };
}

/** An error response for a set_model porcupine does not route, else null. */
export function rejectSetModel(cmd: PiCommand, env: NodeJS.ProcessEnv): PiResponse | null {
  if (cmd.type !== "set_model") return null;
  const { provider, modelId } = cmd;
  if (typeof provider === "string" && typeof modelId === "string" && allowedModel({ provider, id: modelId }, env)) {
    return null;
  }
  return { success: false, error: `model not available: ${String(provider)}/${String(modelId)}` };
}
