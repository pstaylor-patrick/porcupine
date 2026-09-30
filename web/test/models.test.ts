import { describe, expect, it } from "vitest";
import { filterModels, parseModel, sheetState, type ModelInfo } from "../src/models.js";

describe("parseModel", () => {
  it("keeps the widened fields", () => {
    expect(
      parseModel({
        id: "anthropic/claude-opus-5.5",
        name: "Claude Opus 5.5",
        provider: "vercel-ai-gateway",
        api: "x",
        reasoning: true,
        contextWindow: 1_000_000,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5 },
      }),
    ).toEqual({
      id: "anthropic/claude-opus-5.5",
      name: "Claude Opus 5.5",
      provider: "vercel-ai-gateway",
      reasoning: true,
      contextWindow: 1_000_000,
      input: ["text", "image"],
      cost: { input: 5, output: 25 },
    });
  });

  it("rejects entries without id or provider and drops bad optional fields", () => {
    expect(parseModel(null)).toBeNull();
    expect(parseModel({ id: "x" })).toBeNull();
    expect(parseModel({ provider: "p" })).toBeNull();
    expect(parseModel({ id: "x", provider: "p", contextWindow: "big", reasoning: "yes", input: [1, "text"] })).toEqual({
      id: "x",
      provider: "p",
      input: ["text"],
    });
  });
});

describe("filterModels", () => {
  const models: ModelInfo[] = [
    { provider: "vercel-ai-gateway", id: "anthropic/claude-sonnet-5.5" },
    { provider: "vercel-ai-gateway", id: "openai/gpt-5", name: "GPT-5" },
    { provider: "other", id: "claude-x" },
  ];
  it("matches all terms against provider/id and name", () => {
    expect(filterModels(models, "sonnet").map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5.5"]);
    expect(filterModels(models, "vercel claude")).toHaveLength(1);
    expect(filterModels(models, "gpt-5")).toHaveLength(1);
    expect(filterModels(models, "  ")).toHaveLength(3);
  });
});

describe("sheetState", () => {
  const one: ModelInfo[] = [{ id: "m", provider: "p" }];
  it("orders detached, loading, error, empty, ready", () => {
    expect(sheetState({ attached: false, loading: true, error: "x", models: one })).toBe("detached");
    expect(sheetState({ attached: true, loading: true, error: "x", models: one })).toBe("loading");
    expect(sheetState({ attached: true, loading: false, error: "x", models: one })).toBe("error");
    expect(sheetState({ attached: true, loading: false, error: null, models: [] })).toBe("empty");
    expect(sheetState({ attached: true, loading: false, error: null, models: one })).toBe("ready");
  });
});
