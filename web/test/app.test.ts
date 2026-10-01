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
      { provider: "openrouter", id: "anthropic/claude-sonnet-5.5" },
      { provider: "openrouter", id: "openai/gpt-5" },
      { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus" },
    ];
    expect(filterModels(models, "sonnet").map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5.5"]);
    expect(filterModels(models, "openrouter claude")).toHaveLength(1);
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
    app.isDesktop = () => false;
    app.bind();
    return { app, conn, sent };
  }

  it("shows the jump button only when scrolled up from the bottom", () => {
    const { app } = setup({});
    const main = document.getElementById("main") as HTMLElement;
    Object.defineProperty(main, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(main, "clientHeight", { value: 500, configurable: true });
    main.scrollTop = 1500;
    app.syncJump();
    expect(document.getElementById("jump-bottom")?.hidden).toBe(true);
    main.scrollTop = 200;
    app.syncJump();
    expect(document.getElementById("jump-bottom")?.hidden).toBe(false);
  });

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
    expect(document.querySelector("#model-card .model-card-name")?.textContent).toBe("m1");
    expect(document.querySelector("#model-card .model-card-vendor")?.textContent).toBe("p");
    expect((document.getElementById("thinking-select") as HTMLSelectElement).value).toBe("high");
  });

  it("uses the documented set_model and set_thinking_level field names", async () => {
    const { app, sent } = setup({});
    await app.setModel({ provider: "anthropic", id: "claude-sonnet-5-5" });
    await app.setThinking("low");
    expect(sent).toEqual([
      { type: "set_model", provider: "anthropic", modelId: "claude-sonnet-5-5" },
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

  const sessions = [
    { id: "s1", name: "alpha", cwd: "/home/me/code/alpha", model: null, isStreaming: false, startedAt: "1", piVersion: "0.74.0" },
    { id: "s2", name: "beta", cwd: "/srv/beta/", model: null, isStreaming: true, startedAt: "2" },
  ];
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const esc = () => new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });

  it("opens the sidebar flyout, lists sessions, and attaches on tap", () => {
    const { app, conn } = setup({});
    const attach = vi.spyOn(conn, "attach").mockImplementation((id) => {
      conn.sessionId = id;
    });
    app.onFrame({ t: "sessions", sessions });
    expect(byId("session-empty").hidden).toBe(true);
    const items = [...document.querySelectorAll<HTMLButtonElement>(".session-item")];
    expect(items.map((b) => b.querySelector(".session-cwd")?.textContent)).toEqual(["alpha", "beta"]);
    expect(items[1]?.querySelector(".session-streaming")?.getAttribute("aria-label")).toBe("running");

    byId("menu-button").click();
    expect(byId("menu-button").getAttribute("aria-expanded")).toBe("true");
    expect(byId("sidebar").dataset.open).toBe("true");
    expect(byId("sidebar").getAttribute("aria-modal")).toBe("true");
    expect(byId("scrim").hidden).toBe(false);

    items[1]?.click();
    expect(attach).toHaveBeenCalledWith("s2");
    expect(byId("sidebar").dataset.open).toBe("false");
    expect(byId("menu-button").getAttribute("aria-expanded")).toBe("false");
    expect(byId("scrim").hidden).toBe(true);
    expect(byId("session-title").textContent).toBe("beta");
  });

  it("shows an empty state and closes the flyout on scrim tap", () => {
    const { app } = setup({});
    app.onFrame({ t: "sessions", sessions: [] });
    expect(byId("session-empty").hidden).toBe(false);
    expect(byId("session-empty").textContent).toContain("porcupine");
    byId("menu-button").click();
    byId("scrim").click();
    expect(byId("sidebar").dataset.open).toBe("false");
    expect(app.overlays).toEqual([]);
  });

  it("navigates to the settings screen and back, and logs out with POST /api/logout", async () => {
    const { app, conn } = setup({});
    vi.spyOn(conn, "attach").mockImplementation((id) => {
      conn.sessionId = id;
    });
    app.onFrame({ t: "sessions", sessions });
    app.selectSession("s1");
    byId("menu-button").click();
    byId("settings-link").click();
    expect(byId("settings").hidden).toBe(false);
    expect(byId("sidebar").dataset.open).toBe("false");
    expect(document.activeElement?.id).toBe("settings-back");
    expect(byId("settings-pi-row").hidden).toBe(false);
    expect(byId("settings-pi-version").textContent).toBe("0.74.0");
    app.handlers().onStatus("open");
    expect(byId("settings-conn").textContent).toBe("Connected");
    byId("settings-back").click();
    expect(byId("settings").hidden).toBe(true);

    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();
    app.navigate = navigate;
    byId("logout").click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
    expect(fetchMock).toHaveBeenCalledWith("/api/logout", expect.objectContaining({ method: "POST" }));
    vi.unstubAllGlobals();
  });

  it("omits the pi version row when the session has none", () => {
    const { app, conn } = setup({});
    vi.spyOn(conn, "attach").mockImplementation((id) => {
      conn.sessionId = id;
    });
    app.onFrame({ t: "sessions", sessions });
    app.selectSession("s2");
    app.openSettings();
    expect(byId("settings-pi-row").hidden).toBe(true);
  });

  it("opens and closes the session sheet from the header", () => {
    const { app } = setup({});
    byId("sheet-button").click();
    expect(byId("sheet").dataset.open).toBe("true");
    expect(byId("sheet-button").getAttribute("aria-expanded")).toBe("true");
    expect(byId("sheet").getAttribute("role")).toBe("dialog");
    expect(document.activeElement?.id).toBe("sheet-title");
    byId("sheet-close").click();
    expect(byId("sheet").dataset.open).toBe("false");
    expect(document.activeElement?.id).toBe("sheet-button");
    byId("sheet-button").click();
    byId("scrim").click();
    expect(app.overlays).toEqual([]);
  });

  it("shows the full session name and cwd in the sheet", () => {
    const { app, conn } = setup({});
    vi.spyOn(conn, "attach").mockImplementation((id) => {
      conn.sessionId = id;
    });
    app.onFrame({ t: "sessions", sessions });
    expect(byId("session-card-name").textContent).toBe("No session");
    expect(byId("session-card-cwd").hidden).toBe(true);
    app.selectSession("s1");
    expect(byId("session-card-name").textContent).toBe("alpha");
    expect(byId("session-card-cwd").textContent).toBe("/home/me/code/alpha");
    expect(byId("session-card-cwd").hidden).toBe(false);
    expect(byId("session-title").getAttribute("aria-label")).toBe("Session settings for alpha");
  });

  it("opens the sheet from the title and returns focus to it", () => {
    setup({});
    byId("session-title").click();
    expect(byId("sheet").dataset.open).toBe("true");
    expect(byId("session-title").getAttribute("aria-expanded")).toBe("true");
    byId("sheet-close").click();
    expect(byId("sheet").dataset.open).toBe("false");
    expect(document.activeElement?.id).toBe("session-title");
    byId("session-title").click();
    expect(byId("sheet").dataset.open).toBe("true");
    document.dispatchEvent(esc());
    expect(byId("sheet").dataset.open).toBe("false");
    expect(document.activeElement?.id).toBe("session-title");
  });

  it("Esc closes an open overlay before it aborts", async () => {
    const { app, conn, sent } = setup({});
    conn.sessionId = "s1";
    app.t.isStreaming = true;
    const input = byId("input");
    app.openSheet();
    await Promise.resolve();
    sent.length = 0;
    input.focus();
    input.dispatchEvent(esc());
    expect(byId("sheet").dataset.open).toBe("false");
    await Promise.resolve();
    expect(sent).toEqual([]);

    byId("menu-button").click();
    document.dispatchEvent(esc());
    expect(app.overlays).toEqual([]);
    await Promise.resolve();
    expect(sent).toEqual([]);

    input.dispatchEvent(esc());
    await vi.waitFor(() => expect(sent).toEqual([{ type: "abort" }]));
  });

  it("sends set_model and set_thinking_level with the right fields from the sheet", async () => {
    const { app, conn, sent } = setup({
      get_available_models: {
        success: true,
        data: { models: [{ provider: "openrouter", id: "anthropic/claude-sonnet-5.5" }, { provider: "openrouter", id: "openai/gpt-5" }] },
      },
    });
    conn.sessionId = "s1";
    app.openSheet();
    await vi.waitFor(() => expect(document.querySelectorAll("#model-groups .model-option")).toHaveLength(2));
    const filter = byId("model-filter") as HTMLInputElement;
    filter.value = "gpt";
    filter.dispatchEvent(new Event("input"));
    const options = document.querySelectorAll<HTMLButtonElement>("#model-groups .model-option");
    expect(options).toHaveLength(1);
    options[0]?.click();
    const select = byId("thinking-select") as HTMLSelectElement;
    select.value = "high";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(sent.map((c) => c.type)).toContain("set_thinking_level"));
    expect(sent.filter((c) => c.type !== "get_session_stats" && c.type !== "get_state")).toEqual([
      { type: "get_available_models" },
      { type: "set_model", provider: "openrouter", modelId: "openai/gpt-5" },
      { type: "set_thinking_level", level: "high" },
    ]);
    await vi.waitFor(() => expect(document.querySelector("#model-card .model-card-name")?.textContent).toBe("openai/gpt-5"));
  });

  it("groups models by vendor, lists recent first and filters across groups", async () => {
    localStorage.clear();
    const { app, conn } = setup({
      get_state: { success: true, data: { model: { id: "openai/gpt-5", provider: "g" }, thinkingLevel: "low" } },
      get_available_models: {
        success: true,
        data: {
          models: [
            { provider: "g", id: "anthropic/claude-opus-5.5" },
            { provider: "g", id: "anthropic/claude-sonnet-5.5" },
            { provider: "g", id: "openai/gpt-5" },
            { provider: "g", id: "zai/glm-5" },
          ],
        },
      },
    });
    conn.sessionId = "s1";
    app.model = { id: "openai/gpt-5", provider: "g" };
    app.openSheet();
    await vi.waitFor(() => expect(document.querySelectorAll("#model-groups details")).toHaveLength(3));
    const groups = [...document.querySelectorAll<HTMLDetailsElement>("#model-groups details")];
    expect(groups.map((d) => d.querySelector("summary")?.textContent)).toEqual(["anthropic(2)", "openai(1)", "zai(1)"]);
    expect(groups.map((d) => d.open)).toEqual([false, true, false]);
    expect(byId("model-recent").hidden).toBe(false);
    expect([...document.querySelectorAll("#model-recent .model-option-name")].map((n) => n.textContent)).toEqual(["anthropic/claude-opus-5.5"]);

    const filter = byId("model-filter") as HTMLInputElement;
    filter.value = "claude";
    filter.dispatchEvent(new Event("input"));
    expect(byId("model-recent").hidden).toBe(true);
    const open = [...document.querySelectorAll<HTMLDetailsElement>("#model-groups details")];
    expect(open.map((d) => [d.dataset.vendor, d.open])).toEqual([["anthropic", true]]);

    filter.value = "nothing-here";
    filter.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("#model-groups details")).toHaveLength(0);
    expect(byId("model-state").textContent).toBe("No matches");
    expect(byId("model-state").hidden).toBe(false);

    filter.value = "";
    filter.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("#model-groups details")).toHaveLength(3);
    expect(byId("model-state").hidden).toBe(true);

    document.querySelector<HTMLButtonElement>('#model-groups details[data-vendor="zai"] .model-option')?.click();
    await vi.waitFor(() =>
      expect([...document.querySelectorAll("#model-recent .model-option-name")].map((n) => n.textContent)).toEqual(["zai/glm-5", "anthropic/claude-opus-5.5"]),
    );
    localStorage.clear();
  });

  it("filters with capability chips and jumps to a vendor group", async () => {
    localStorage.clear();
    const { app, conn } = setup({
      get_available_models: {
        success: true,
        data: {
          models: [
            { provider: "g", id: "anthropic/claude-opus-5.5", reasoning: true, input: ["text", "image"] },
            { provider: "g", id: "anthropic/claude-haiku-5", reasoning: false, input: ["text", "image"] },
            { provider: "g", id: "openai/gpt-5", reasoning: true, input: ["text"] },
            { provider: "g", id: "zai/glm-5", reasoning: false, input: ["text"] },
          ],
        },
      },
    });
    conn.sessionId = "s1";
    app.openSheet();
    await vi.waitFor(() => expect(document.querySelectorAll("#model-groups details")).toHaveLength(3));
    const chips = [...document.querySelectorAll<HTMLButtonElement>("#model-chips .filter-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["Thinking", "Images", "400K+", "Cheap"]);
    expect(chips.every((c) => c.getAttribute("aria-pressed") === "false")).toBe(true);
    const chip = (cap: string) => document.querySelector<HTMLButtonElement>(`#model-chips [data-cap="${cap}"]`)!;
    const names = () => [...document.querySelectorAll("#model-groups .model-option-name")].map((n) => n.textContent);

    chip("thinking").click();
    expect(chip("thinking").getAttribute("aria-pressed")).toBe("true");
    expect(names()).toEqual(["anthropic/claude-opus-5.5", "openai/gpt-5"]);
    expect([...document.querySelectorAll<HTMLDetailsElement>("#model-groups details")].every((d) => d.open)).toBe(true);

    chip("images").click();
    expect(names()).toEqual(["anthropic/claude-opus-5.5"]);
    expect(byId("vendor-jump").hidden).toBe(true);

    chip("images").click();
    const filter = byId("model-filter") as HTMLInputElement;
    filter.value = "gpt";
    filter.dispatchEvent(new Event("input"));
    expect(names()).toEqual(["openai/gpt-5"]);
    filter.value = "";
    filter.dispatchEvent(new Event("input"));

    byId("sheet-close").click();
    app.openSheet();
    expect(chip("thinking").getAttribute("aria-pressed")).toBe("true");
    expect(names()).toEqual(["anthropic/claude-opus-5.5", "openai/gpt-5"]);

    chip("thinking").click();
    expect(chip("thinking").getAttribute("aria-pressed")).toBe("false");
    expect(names()).toHaveLength(4);

    const jump = byId("vendor-jump") as HTMLSelectElement;
    expect(jump.hidden).toBe(false);
    expect([...jump.options].map((o) => [o.value, o.textContent])).toEqual([
      ["", "Jump to vendor"],
      ["anthropic", "anthropic (2)"],
      ["openai", "openai (1)"],
      ["zai", "zai (1)"],
    ]);
    const zai = document.querySelector<HTMLDetailsElement>('#model-groups details[data-vendor="zai"]')!;
    expect(zai.open).toBe(false);
    jump.value = "zai";
    jump.dispatchEvent(new Event("change"));
    expect(zai.open).toBe(true);
    expect(jump.value).toBe("");
    expect(document.activeElement).toBe(zai.querySelector("summary"));
    localStorage.clear();
  });

  it("groups direct-provider ids by vendor, keys recents by provider and drops stale recents", async () => {
    localStorage.clear();
    localStorage.setItem("porcupine.recentModels", JSON.stringify(["vercel-ai-gateway|anthropic/claude-opus-5.5", "openai|gpt-5"]));
    const mixed = {
      success: true,
      data: {
        models: [
          { provider: "anthropic", id: "claude-opus-5-5", reasoning: true },
          { provider: "openai", id: "gpt-5" },
          { provider: "openrouter", id: "zai/glm-5" },
        ],
      },
    };
    const { app, conn, sent } = setup({ get_available_models: mixed });
    conn.sessionId = "s1";
    app.openSheet();
    await vi.waitFor(() => expect(document.querySelectorAll("#model-groups details")).toHaveLength(3));
    const vendors = [...document.querySelectorAll<HTMLDetailsElement>("#model-groups details")].map((d) => d.dataset.vendor).sort();
    expect(vendors).toEqual(["anthropic", "openai", "zai"]);
    const recents = () => [...document.querySelectorAll("#model-recent .model-option-name")].map((e) => e.textContent);
    expect(recents()).toEqual(["gpt-5"]);
    expect(document.querySelectorAll("#model-chips [data-provider]")).toHaveLength(0);
    expect(document.querySelectorAll("#model-chips .filter-chip")).toHaveLength(4);

    const opus = [...document.querySelectorAll<HTMLButtonElement>("#model-groups .model-option")].find(
      (b) => b.querySelector(".model-option-name")?.textContent === "claude-opus-5-5",
    )!;
    opus.click();
    await vi.waitFor(() => expect(sent).toContainEqual({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5-5" }));
    await vi.waitFor(() => expect(recents()).toEqual(["claude-opus-5-5", "gpt-5"]));
    expect(JSON.parse(localStorage.getItem("porcupine.recentModels")!)[0]).toBe("anthropic|claude-opus-5-5");
    localStorage.clear();
  });

  it("shows distinct model sheet states", async () => {
    const { app, conn } = setup({ get_available_models: { success: true, data: { models: [] } } });
    app.openSheet();
    expect(byId("model-state").textContent).toBe("Not attached: pick a session");
    conn.sessionId = "s1";
    const p = app.loadModels();
    expect(byId("model-state").textContent).toBe("Loading models");
    await p;
    expect(byId("model-state").textContent).toBe("No models available (check the provider key)");
  });

  it("renders a model load error in the sheet and the transcript", async () => {
    const { app, conn } = setup({ get_available_models: { success: false, error: "boom" } });
    conn.sessionId = "s1";
    await app.loadModels();
    expect(byId("model-state").textContent).toContain("boom");
    expect(app.modelsError).toBe("boom");
  });

  it("disables the thinking select when the model has no reasoning", async () => {
    const { app, conn } = setup({ get_state: { success: true, data: { model: { id: "m", provider: "p", reasoning: false }, thinkingLevel: "low" } } });
    conn.sessionId = "s1";
    await app.refreshState();
    const select = byId("thinking-select") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("off");
  });

  it("toggles body.is-streaming with the run status", () => {
    const { app } = setup({});
    app.t.isStreaming = true;
    app.render();
    expect(document.body.classList.contains("is-streaming")).toBe(true);
    expect(byId("run-status").textContent).toBe("Running");
    app.t.isStreaming = false;
    app.render();
    expect(document.body.classList.contains("is-streaming")).toBe(false);
  });

  it("uses the steer toggle from the sheet for prompts sent while streaming", async () => {
    const { app, conn, sent } = setup({});
    conn.sessionId = "s1";
    app.t.isStreaming = true;
    (byId("steer") as HTMLInputElement).checked = true;
    (byId("input") as HTMLTextAreaElement).value = "change course";
    await app.send();
    expect(sent[0]).toEqual({ type: "prompt", message: "change course", images: [], streamingBehavior: "steer" });
  });
});

