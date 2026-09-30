import { describe, expect, it } from "vitest";
import { allowedModel, filterModelsResponse, rejectSetModel, routeProvider, vendorOfId } from "../src/cli/routing.js";

const NONE = { OPENROUTER_API_KEY: "sk-or-test", AI_GATEWAY_API_KEY: "vk" };
const BOTH = { ...NONE, ANTHROPIC_API_KEY: "ak", OPENAI_API_KEY: "sk-test" };

describe("routeProvider", () => {
  it("routes everything to OpenRouter without direct keys", () => {
    expect(routeProvider("anthropic", NONE)).toBe("openrouter");
    expect(routeProvider("openai", NONE)).toBe("openrouter");
    expect(routeProvider("google", NONE)).toBe("openrouter");
  });
  it("routes Anthropic and OpenAI direct when keyed", () => {
    expect(routeProvider("anthropic", BOTH)).toBe("anthropic");
    expect(routeProvider("openai", BOTH)).toBe("openai");
    expect(routeProvider("google", BOTH)).toBe("openrouter");
    expect(routeProvider("", BOTH)).toBe("openrouter");
  });
});

describe("vendorOfId", () => {
  it("takes the prefix before the slash", () => {
    expect(vendorOfId("anthropic/claude-opus-5.5")).toBe("anthropic");
    expect(vendorOfId("gpt-5")).toBe("");
  });
});

describe("allowedModel", () => {
  it("keeps only OpenRouter without direct keys", () => {
    expect(allowedModel({ provider: "openrouter", id: "anthropic/claude-opus-5.5" }, NONE)).toBe(true);
    expect(allowedModel({ provider: "openrouter", id: "openai/gpt-oss-120b" }, NONE)).toBe(true);
    expect(allowedModel({ provider: "anthropic", id: "claude-opus-5-5" }, NONE)).toBe(false);
    expect(allowedModel({ provider: "openai", id: "gpt-5" }, NONE)).toBe(false);
  });
  it("drops OpenRouter's copies once a vendor is keyed direct", () => {
    expect(allowedModel({ provider: "anthropic", id: "claude-opus-5-5" }, BOTH)).toBe(true);
    expect(allowedModel({ provider: "openai", id: "gpt-5" }, BOTH)).toBe(true);
    expect(allowedModel({ provider: "openrouter", id: "anthropic/claude-opus-5.5" }, BOTH)).toBe(false);
    expect(allowedModel({ provider: "openrouter", id: "openai/gpt-oss-120b" }, BOTH)).toBe(false);
    expect(allowedModel({ provider: "openrouter", id: "google/gemini-3-pro" }, BOTH)).toBe(true);
  });
  it("drops every other provider", () => {
    for (const provider of ["vercel-ai-gateway", "github-copilot", "opencode"]) {
      expect(allowedModel({ provider, id: "anthropic/claude-opus-5.5" }, BOTH)).toBe(false);
    }
  });
});

describe("filterModelsResponse", () => {
  it("filters data.models and keeps the rest of the response", () => {
    const r = {
      success: true,
      command: "get_available_models",
      data: {
        models: [
          { provider: "openrouter", id: "anthropic/claude-opus-5.5" },
          { provider: "anthropic", id: "claude-opus-5-5" },
          { provider: "vercel-ai-gateway", id: "anthropic/claude-opus-5.5" },
          null,
        ],
      },
    };
    expect(filterModelsResponse(r, { ANTHROPIC_API_KEY: "ak" })).toEqual({
      success: true,
      command: "get_available_models",
      data: { models: [{ provider: "anthropic", id: "claude-opus-5-5" }] },
    });
  });
  it("passes failures and odd shapes through", () => {
    const fail = { success: false, error: "x" };
    expect(filterModelsResponse(fail, {})).toBe(fail);
    const odd = { success: true, data: {} };
    expect(filterModelsResponse(odd, {})).toBe(odd);
  });
});

describe("rejectSetModel", () => {
  it("rejects unrouted models and ignores other commands", () => {
    expect(rejectSetModel({ type: "set_model", provider: "openrouter", modelId: "openai/gpt-5" }, NONE)).toBeNull();
    expect(rejectSetModel({ type: "set_model", provider: "openrouter", modelId: "openai/gpt-5" }, BOTH)).toEqual({
      success: false,
      error: "model not available: openrouter/openai/gpt-5",
    });
    expect(rejectSetModel({ type: "set_model" }, BOTH)?.success).toBe(false);
    expect(rejectSetModel({ type: "get_state" }, BOTH)).toBeNull();
  });
});
