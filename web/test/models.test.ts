import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CHEAP_INPUT_MAX,
  duplicateIds,
  providersOf,
  filterModels,
  migrateRecent,
  providerLabel,
  providerTitle,
  recentKey,
  resolveRecent,
  hasCapability,
  LONG_CONTEXT_MIN,
  formatContext,
  formatPrice,
  groupByVendor,
  loadRecent,
  parseModel,
  pushRecent,
  RECENT_KEY,
  RECENT_MAX,
  RECENT_SEED,
  rowDetail,
  sheetState,
  vendorOf,
  type Capability,
  type ModelInfo,
  type RecentStorage,
} from "../src/models.js";

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

describe("vendorOf", () => {
  it("takes the id prefix", () => expect(vendorOf("anthropic/claude-opus-5.5", "vercel-ai-gateway")).toBe("anthropic"));
  it("falls back to the provider", () => expect(vendorOf("m1", "p")).toBe("p"));
});

describe("formatContext", () => {
  it("formats millions and thousands", () => {
    expect(formatContext(1_000_000)).toBe("1M ctx");
    expect(formatContext(200_000)).toBe("200K ctx");
    expect(formatContext(128_000)).toBe("128K ctx");
  });
  it("returns null when unknown", () => {
    expect(formatContext(undefined)).toBeNull();
    expect(formatContext(0)).toBeNull();
  });
});

describe("formatPrice", () => {
  it("formats in/out per million", () => {
    expect(formatPrice({ input: 3, output: 15 })).toBe("$3/$15 per M");
    expect(formatPrice({ input: 1.5, output: 7.123 })).toBe("$1.5/$7.12 per M");
  });
  it("omits missing or zero cost", () => {
    expect(formatPrice(undefined)).toBeNull();
    expect(formatPrice({})).toBeNull();
    expect(formatPrice({ input: 0, output: 0 })).toBeNull();
  });
});

describe("rowDetail", () => {
  it("joins context, flags and price", () => {
    const m: ModelInfo = { id: "a/b", provider: "p", contextWindow: 1_000_000, reasoning: true, input: ["text", "image"], cost: { input: 5, output: 25 } };
    expect(rowDetail(m)).toBe("1M ctx - thinking - images - $5/$25 per M");
  });
  it("leaves out missing parts", () => {
    expect(rowDetail({ id: "a/b", provider: "p", reasoning: false, input: ["text"], cost: { input: 0, output: 0 } })).toBe("");
    expect(rowDetail({ id: "a/b", provider: "p", contextWindow: 200_000 })).toBe("200K ctx");
  });
});

describe("groupByVendor", () => {
  it("groups by id prefix, sorted by vendor, with counts", () => {
    const ms: ModelInfo[] = [
      { id: "openai/gpt-5", provider: "g" },
      { id: "anthropic/claude-a", provider: "g" },
      { id: "openai/gpt-4", provider: "g" },
      { id: "bare", provider: "p" },
    ];
    const g = groupByVendor(ms);
    expect(g.map((x) => [x.vendor, x.count])).toEqual([
      ["anthropic", 1],
      ["openai", 2],
      ["p", 1],
    ]);
    expect(g[1]?.models.map((m) => m.id)).toEqual(["openai/gpt-5", "openai/gpt-4"]);
    expect(groupByVendor([])).toEqual([]);
  });
});

function memStorage(): RecentStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("recent models", () => {
  it("seeds with the CLI default", () => {
    expect(loadRecent(memStorage())).toEqual([RECENT_SEED]);
    expect(loadRecent(null)).toEqual([RECENT_SEED]);
  });

  it("falls back to the seed on garbage", () => {
    const s = memStorage();
    s.data.set(RECENT_KEY, "{not json");
    expect(loadRecent(s)).toEqual([RECENT_SEED]);
    s.data.set(RECENT_KEY, JSON.stringify({ a: 1 }));
    expect(loadRecent(s)).toEqual([RECENT_SEED]);
    s.data.set(RECENT_KEY, JSON.stringify([1, "", "x/y"]));
    expect(loadRecent(s)).toEqual(["x/y"]);
  });

  it("pushes most recent first, dedupes and caps at 8", () => {
    const s = memStorage();
    expect(pushRecent(s, "a/1")).toEqual(["a/1", RECENT_SEED]);
    pushRecent(s, RECENT_SEED);
    expect(loadRecent(s)).toEqual([RECENT_SEED, "a/1"]);
    for (let i = 0; i < 10; i++) pushRecent(s, `v/${i}`);
    const r = loadRecent(s);
    expect(r).toHaveLength(RECENT_MAX);
    expect(r[0]).toBe("v/9");
  });

  it("survives a storage that throws", () => {
    const s: RecentStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadRecent(s)).toEqual([RECENT_SEED]);
    expect(pushRecent(s, "a/1")).toEqual(["a/1", RECENT_SEED]);
  });
});

describe("capability filters", () => {
  const base: ModelInfo = { id: "v/base", provider: "p" };
  const think: ModelInfo = { id: "v/think", provider: "p", reasoning: true, input: ["text"] };
  const vision: ModelInfo = { id: "v/vision", provider: "p", input: ["text", "image"] };
  const both: ModelInfo = { id: "v/both", provider: "p", reasoning: true, input: ["text", "image"], contextWindow: 400_000 };

  it("exports the four capabilities and thresholds", () => {
    expect(CAPABILITIES.map((c) => c.key)).toEqual(["thinking", "images", "long", "cheap"]);
    expect(LONG_CONTEXT_MIN).toBe(400_000);
    expect(CHEAP_INPUT_MAX).toBe(0.5);
  });

  it("thinking and images", () => {
    expect(hasCapability(think, "thinking")).toBe(true);
    expect(hasCapability(base, "thinking")).toBe(false);
    expect(hasCapability({ ...base, reasoning: false }, "thinking")).toBe(false);
    expect(hasCapability(vision, "images")).toBe(true);
    expect(hasCapability(think, "images")).toBe(false);
    expect(hasCapability(base, "images")).toBe(false);
  });

  it("long context is inclusive at 400K", () => {
    expect(hasCapability({ ...base, contextWindow: 400_000 }, "long")).toBe(true);
    expect(hasCapability({ ...base, contextWindow: 399_999 }, "long")).toBe(false);
    expect(hasCapability(base, "long")).toBe(false);
  });

  it("cheap is inclusive at 0.5; missing or zero input cost is not cheap", () => {
    expect(hasCapability({ ...base, cost: { input: 0.5, output: 1 } }, "cheap")).toBe(true);
    expect(hasCapability({ ...base, cost: { input: 0.51, output: 1 } }, "cheap")).toBe(false);
    expect(hasCapability({ ...base, cost: { input: 0, output: 0 } }, "cheap")).toBe(false);
    expect(hasCapability({ ...base, cost: { output: 1 } }, "cheap")).toBe(false);
    expect(hasCapability(base, "cheap")).toBe(false);
  });

  const all = [base, think, vision, both];
  const ids = (ms: ModelInfo[]) => ms.map((m) => m.id);

  it("ANDs selected capabilities", () => {
    expect(ids(filterModels(all, "", new Set<Capability>(["thinking"])))).toEqual(["v/think", "v/both"]);
    expect(ids(filterModels(all, "", new Set<Capability>(["thinking", "images"])))).toEqual(["v/both"]);
  });

  it("combines capabilities with text", () => {
    expect(ids(filterModels(all, "v/think", new Set<Capability>(["thinking"])))).toEqual(["v/think"]);
    expect(filterModels(all, "vision", new Set<Capability>(["thinking"]))).toEqual([]);
  });

  it("matches typed capability words", () => {
    expect(ids(filterModels(all, "thinking"))).toEqual(["v/think", "v/both"]);
    expect(ids(filterModels(all, "images"))).toEqual(["v/vision", "v/both"]);
    expect(ids(filterModels(all, "thinking images"))).toEqual(["v/both"]);
  });

  it("returns the same array for empty query and empty set", () => {
    expect(filterModels(all, "")).toBe(all);
    expect(filterModels(all, "  ", new Set())).toBe(all);
  });
});

describe("providers", () => {
  const OR = "openrouter";
  const VG = "vercel-ai-gateway";
  const models: ModelInfo[] = [
    { provider: OR, id: "anthropic/claude-opus-5.5", reasoning: true },
    { provider: VG, id: "anthropic/claude-opus-5.5", reasoning: true },
    { provider: VG, id: "openai/gpt-5", reasoning: false },
    { provider: OR, id: "zai/glm-5", reasoning: true },
  ];
  const ids = (ms: ModelInfo[]) => ms.map((m) => `${m.provider}|${m.id}`);

  it("finds ids served by more than one provider", () => {
    expect([...duplicateIds(models)]).toEqual(["anthropic/claude-opus-5.5"]);
    expect(duplicateIds([models[0]!, models[0]!]).size).toBe(0);
  });

  it("labels known providers and falls back to the raw id", () => {
    expect(providerLabel(OR)).toBe("OpenRouter");
    expect(providerLabel(VG)).toBe("Vercel");
    expect(providerTitle(VG)).toBe("Vercel AI Gateway");
    expect(providerLabel("acme")).toBe("acme");
    expect(providerTitle("acme")).toBe("acme");
  });

  it("filters by provider, OR among providers and AND with capabilities and text", () => {
    expect(filterModels(models, "", new Set(), new Set())).toBe(models);
    expect(ids(filterModels(models, "", new Set(), new Set([VG])))).toEqual([`${VG}|anthropic/claude-opus-5.5`, `${VG}|openai/gpt-5`]);
    expect(filterModels(models, "", new Set(), new Set([VG, OR]))).toHaveLength(4);
    expect(ids(filterModels(models, "", new Set<Capability>(["thinking"]), new Set([VG])))).toEqual([`${VG}|anthropic/claude-opus-5.5`]);
    expect(ids(filterModels(models, "glm", new Set(), new Set([OR, VG])))).toEqual([`${OR}|zai/glm-5`]);
    expect(filterModels(models, "glm", new Set(), new Set([VG]))).toEqual([]);
  });

  it("migrates id-only recents to provider|id, preferring the current provider, and dedupes", () => {
    expect(recentKey(models[1]!)).toBe(`${VG}|anthropic/claude-opus-5.5`);
    const old = ["anthropic/claude-opus-5.5", `${OR}|zai/glm-5`, "gone/x"];
    expect(ids(resolveRecent(old, models, VG))).toEqual([`${VG}|anthropic/claude-opus-5.5`, `${OR}|zai/glm-5`]);
    expect(ids(resolveRecent(old, models))).toEqual([`${OR}|anthropic/claude-opus-5.5`, `${OR}|zai/glm-5`]);
    expect(ids(resolveRecent([`${OR}|zai/glm-5`, "zai/glm-5"], models))).toEqual([`${OR}|zai/glm-5`]);
    expect(migrateRecent(old, models, VG)).toEqual([`${VG}|anthropic/claude-opus-5.5`, `${OR}|zai/glm-5`, "gone/x"]);
    expect(migrateRecent([`${OR}|zai/glm-5`, "zai/glm-5"], models)).toEqual([`${OR}|zai/glm-5`]);

    const s = memStorage();
    s.data.set(RECENT_KEY, JSON.stringify(["anthropic/claude-opus-5.5", "zai/glm-5"]));
    expect(pushRecent(s, `${OR}|zai/glm-5`, models, OR)).toEqual([`${OR}|zai/glm-5`, `${OR}|anthropic/claude-opus-5.5`]);
  });
});

describe("providersOf", () => {
  it("lists distinct providers in first-seen order", () => {
    const ms = [
      { provider: "openrouter", id: "a/x" },
      { provider: "vercel-ai-gateway", id: "a/x" },
      { provider: "openrouter", id: "b/y" },
    ];
    expect(providersOf(ms)).toEqual(["openrouter", "vercel-ai-gateway"]);
    expect(providersOf([])).toEqual([]);
  });
});
