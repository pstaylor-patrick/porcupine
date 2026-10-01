// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { MergeModePicker, parseState, type FetchLike } from "../src/merge-mode.js";

const state = (stored: string | null): unknown => ({
  mode: stored ?? "merge-ready",
  stored,
  fallback: "merge-ready",
  modes: ["local-only", "merge-ready", "admin-bypass", "yolo"],
});

describe("MergeModePicker", () => {
  it("shows cf's fallback when unset and saves a choice", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    let current: string | null = null;
    const fetcher: FetchLike = (url, init) => {
      calls.push({ url, init });
      if (init?.method === "POST") current = (JSON.parse(String(init.body)) as { mode: string }).mode;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(state(current)) });
    };
    const select = document.createElement("select");
    const status = document.createElement("p");
    const p = new MergeModePicker(select, status, fetcher);
    await p.load("proj 1");
    expect(calls[0]?.url).toBe("/api/sessions/proj%201/merge-mode");
    expect(select.value).toBe("merge-ready");
    expect(select.options[1]?.textContent).toBe("Merge ready (cf default)");
    expect(status.textContent).toMatch(/cf falls back to Merge ready/);
    await p.save("yolo");
    expect(select.value).toBe("yolo");
    expect(status.textContent).toMatch(/Yolo for this session/);
  });

  it("shows the hub's error and disables the select", async () => {
    const select = document.createElement("select");
    const status = document.createElement("p");
    const p = new MergeModePicker(select, status, () => Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "cf: boom" }) }));
    await p.load("x");
    expect(select.disabled).toBe(true);
    expect(status.textContent).toBe("Merge mode cf: boom");
    expect(parseState({ mode: 1 })).toBeNull();
  });
});
