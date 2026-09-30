// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { App, appTitle, buildPrompt, filterModels, handleComposerKey } from "../src/app.js";
import { Connection, type PiResponse } from "../src/ws.js";
import { loadShell } from "./dom.js";

function key(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: k, cancelable: true, ...init });
}

describe("keyboard", () => {
  it("Enter sends, Shift+Enter does not, Esc aborts", () => {
    const send = vi.fn();
    const abort = vi.fn();
    const enter = key("Enter");
    expect(handleComposerKey(enter, { send, abort })).toBe(true);
    expect(enter.defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);

    const shift = key("Enter", { shiftKey: true });
    expect(handleComposerKey(shift, { send, abort })).toBe(false);
    expect(shift.defaultPrevented).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    expect(handleComposerKey(key("Escape"), { send, abort })).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(handleComposerKey(key("a"), { send, abort })).toBe(false);
  });
});

describe("prompt", () => {
  it("always carries an empty images array and sets streamingBehavior only while streaming", () => {
    expect(buildPrompt("hi", false, "followUp")).toEqual({ type: "prompt", message: "hi", images: [] });
    expect(buildPrompt("hi", true, "followUp")).toEqual({ type: "prompt", message: "hi", images: [], streamingBehavior: "followUp" });
    expect(buildPrompt("hi", true, "steer").streamingBehavior).toBe("steer");
  });
});

describe("models", () => {
  it("filters by provider, id and name terms", () => {
    const models = [
      { provider: "vercel-ai-gateway", id: "anthropic/claude-sonnet-5.5" },
      { provider: "vercel-ai-gateway", id: "openai/gpt-5" },
      { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus" },
    ];
    expect(filterModels(models, "sonnet").map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5.5"]);
    expect(filterModels(models, "vercel claude")).toHaveLength(1);
    expect(filterModels(models, "")).toHaveLength(3);
  });
});

describe("app", () => {
  function setup(responses: Record<string, PiResponse>) {
    loadShell();
    const conn = new Connection({ url: "ws://x/ws", storage: null }, { onFrame: () => undefined, onStatus: () => undefined });
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(conn, "command").mockImplementation((cmd) => {
      sent.push(cmd);
      return Promise.resolve(responses[cmd.type] ?? { success: true });
    });
    const app = new App(conn);
    app.bind();
    return { app, conn, sent };
  }

  it("names the app", () => {
    expect(appTitle()).toBe("Porcupine");
  });

  it("reset rebuilds the transcript from get_messages and reads get_state", async () => {
    const { app, conn, sent } = setup({
      get_messages: { success: true, data: { messages: [{ role: "user", content: "earlier", timestamp: 1 }] } },
      get_state: { success: true, data: { model: { id: "m1", provider: "p" }, thinkingLevel: "high", isStreaming: false } },
    });
    conn.sessionId = "s1";
    app.onFrame({ t: "reset", session: "s1" });
    app.onFrame({ t: "event", session: "s1", seq: 1, event: { type: "message_start", message: { role: "user", content: "earlier", timestamp: 1 } } });
    await vi.waitFor(() => expect(sent.map((c) => c.type)).toContain("get_state"));
    await Promise.resolve();
    app.render();
    expect(sent[0]).toEqual({ type: "get_messages" });
    expect(document.querySelectorAll(".msg.user")).toHaveLength(1);
    expect(document.getElementById("transcript")?.textContent).toContain("earlier");
    expect(document.getElementById("model-button")?.textContent).toBe("m1");
    expect((document.getElementById("thinking-select") as HTMLSelectElement).value).toBe("high");
  });

  it("uses the documented set_model and set_thinking_level field names", async () => {
    const { app, sent } = setup({});
    await app.setModel({ provider: "vercel-ai-gateway", id: "anthropic/claude-sonnet-5.5" });
    await app.setThinking("low");
    expect(sent).toEqual([
      { type: "set_model", provider: "vercel-ai-gateway", modelId: "anthropic/claude-sonnet-5.5" },
      { type: "set_thinking_level", level: "low" },
    ]);
  });

  it("sends a prompt on Enter with images and restores text on rejection", async () => {
    const { app, conn, sent } = setup({ prompt: { success: false, error: "agent is streaming" } });
    conn.sessionId = "s1";
    const input = document.getElementById("input") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await vi.waitFor(() => expect(sent.map((c) => c.type)).toContain("get_state"));
    expect(sent[0]).toEqual({ type: "prompt", message: "hello", images: [] });
    expect(input.value).toBe("hello");
    app.render();
    expect(document.querySelector(".notice-error")?.textContent).toContain("agent is streaming");
  });

  it("Esc in the composer sends abort", async () => {
    const { conn, sent } = setup({});
    conn.sessionId = "s1";
    const input = document.getElementById("input") as HTMLTextAreaElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await vi.waitFor(() => expect(sent).toEqual([{ type: "abort" }]));
  });
});
