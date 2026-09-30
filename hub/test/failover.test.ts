import { describe, expect, it } from "vitest";
import { Failover, isRateLimit, otherProvider, type ModelRef } from "../src/cli/failover.js";
import type { PiCommand, PiEvent, PiResponse } from "../src/shared/protocol.js";

const MODEL = "anthropic/claude-opus-5.5";
const BOTH = { AI_GATEWAY_API_KEY: "vck-test", OPENROUTER_API_KEY: "sk-or-test" };

function harness(env: NodeJS.ProcessEnv = BOTH, setModel: PiResponse = { success: true }) {
  const sent: PiCommand[] = [];
  const published: PiEvent[] = [];
  let current: ModelRef | null = { provider: "vercel-ai-gateway", model: MODEL };
  const f = new Failover({
    send: (cmd) => {
      sent.push(cmd);
      return Promise.resolve(cmd.type === "set_model" ? setModel : { success: true });
    },
    publish: (e) => published.push(e),
    log: () => undefined,
    env,
    current: () => current,
    setCurrent: (m) => {
      current = m;
    },
  });
  return { f, sent, published, current: () => current };
}

const retryFailed = { type: "auto_retry_end", success: false, attempt: 3, finalError: "429 Too Many Requests" };
const settled = { type: "agent_settled" };

async function rateLimitedRun(f: Failover): Promise<void> {
  await f.onEvent(retryFailed);
  await f.onEvent(settled);
}

describe("isRateLimit", () => {
  it.each([
    ["429 status code (no body)", true],
    ["Rate limit exceeded", true],
    ["error: rate_limit_error", true],
    ["Too Many Requests", true],
    ["500 Internal Server Error", false],
    ["context length exceeded", false],
    [undefined, false],
  ])("%s -> %s", (text, want) => {
    expect(isRateLimit(text)).toBe(want);
  });
});

describe("otherProvider", () => {
  it("picks the other keyed provider", () => {
    expect(otherProvider("vercel-ai-gateway", BOTH)).toBe("openrouter");
    expect(otherProvider("openrouter", BOTH)).toBe("vercel-ai-gateway");
    expect(otherProvider("vercel-ai-gateway", { AI_GATEWAY_API_KEY: "vck-test" })).toBeNull();
  });
});

describe("Failover", () => {
  it("switches to the same id on the other provider after retries fail, then re-sends the prompt", async () => {
    const h = harness();
    h.f.onCommand({ type: "prompt", message: "hello", images: [] });
    await rateLimitedRun(h.f);
    expect(h.sent).toEqual([
      { type: "set_model", provider: "openrouter", modelId: MODEL },
      { type: "prompt", message: "hello", images: [] },
    ]);
    expect(h.published).toEqual([
      {
        type: "porcupine_failover",
        from: { provider: "vercel-ai-gateway", model: MODEL },
        to: { provider: "openrouter", model: MODEL },
        reason: "429 Too Many Requests",
      },
    ]);
    expect(h.current()).toEqual({ provider: "openrouter", model: MODEL });
  });

  it("waits for agent_settled before acting", async () => {
    const h = harness();
    h.f.onCommand({ type: "prompt", message: "hello" });
    await h.f.onEvent(retryFailed);
    expect(h.sent).toEqual([]);
  });

  it("also triggers on a final assistant error message without a retry cycle", async () => {
    const h = harness();
    h.f.onCommand({ type: "prompt", message: "hello" });
    await h.f.onEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "rate limit" } });
    await h.f.onEvent(settled);
    expect(h.sent.map((c) => c.type)).toEqual(["set_model", "prompt"]);
  });

  it("fails over at most once per prompt", async () => {
    const h = harness();
    h.f.onCommand({ type: "prompt", message: "hello" });
    await rateLimitedRun(h.f);
    await rateLimitedRun(h.f);
    expect(h.sent.filter((c) => c.type === "set_model")).toHaveLength(1);
    expect(h.published).toHaveLength(1);
  });

  it("resets the guard on a new prompt", async () => {
    const h = harness();
    h.f.onCommand({ type: "prompt", message: "one" });
    await rateLimitedRun(h.f);
    h.f.onCommand({ type: "prompt", message: "two" });
    await rateLimitedRun(h.f);
    expect(h.sent.filter((c) => c.type === "set_model")).toEqual([
      { type: "set_model", provider: "openrouter", modelId: MODEL },
      { type: "set_model", provider: "vercel-ai-gateway", modelId: MODEL },
    ]);
    expect(h.sent.at(-1)).toEqual({ type: "prompt", message: "two" });
  });

  it("ignores errors that are not rate limits", async () => {
    const h = harness();
    h.f.onCommand({ type: "prompt", message: "hello" });
    await h.f.onEvent({ ...retryFailed, finalError: "500 Internal Server Error" });
    await h.f.onEvent(settled);
    expect(h.sent).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it("does nothing when the other provider has no key", async () => {
    const h = harness({ AI_GATEWAY_API_KEY: "vck-test" });
    h.f.onCommand({ type: "prompt", message: "hello" });
    await rateLimitedRun(h.f);
    expect(h.sent).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it("publishes a warning and does not re-prompt when set_model fails", async () => {
    const h = harness(BOTH, { success: false, error: "no such model" });
    h.f.onCommand({ type: "prompt", message: "hello" });
    await rateLimitedRun(h.f);
    expect(h.sent).toEqual([{ type: "set_model", provider: "openrouter", modelId: MODEL }]);
    expect(h.published).toEqual([{ type: "porcupine_notice", level: "warn", text: "failover to OpenRouter failed: no such model" }]);
    expect(h.current()).toEqual({ provider: "vercel-ai-gateway", model: MODEL });
  });

  it("tracks set_model commands forwarded from the browser", () => {
    const h = harness();
    h.f.onResult({ type: "set_model", provider: "openrouter", modelId: "x/y" }, { success: true });
    expect(h.current()).toEqual({ provider: "openrouter", model: "x/y" });
  });
});
