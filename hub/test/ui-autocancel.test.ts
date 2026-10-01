import { describe, expect, it } from "vitest";
import { handleUiRequest, UiStateStore } from "../src/cli/ui-autocancel.js";

// Shapes pinned against pi packages/coding-agent/docs/rpc-extension-ui.md:
// "Cancellation response (any dialog)": {"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
describe("handleUiRequest", () => {
  for (const method of ["select", "confirm", "input", "editor"]) {
    it(`cancels ${method} with the documented shape and a notice`, () => {
      const d = handleUiRequest({ type: "extension_ui_request", id: "uuid-3", method, title: "Allow?" });
      expect(d.response).toStrictEqual({ type: "extension_ui_response", id: "uuid-3", cancelled: true });
      expect(d.event).toEqual({
        type: "porcupine_notice",
        level: "warn",
        text: `extension UI ${method} auto-cancelled: Allow?`,
      });
      expect(d.log).toContain("auto-cancelled");
    });
  }

  it("forwards notify without responding", () => {
    const req = { type: "extension_ui_request", id: "uuid-5", method: "notify", message: "hi" };
    const d = handleUiRequest(req);
    expect(d.response).toBeUndefined();
    expect(d.event).toBe(req);
  });

  it("ignores set_editor_text", () => {
    expect(handleUiRequest({ type: "extension_ui_request", id: "x", method: "set_editor_text" })).toEqual({});
  });

  it("forwards setStatus, setWidget and setTitle as porcupine_ui_* events", () => {
    const r = (o: Record<string, unknown>) => handleUiRequest({ type: "extension_ui_request", id: "x", ...o }).event;
    expect(r({ method: "setStatus", statusKey: "loop", statusText: "every 5m" })).toEqual({ type: "porcupine_ui_status", key: "loop", text: "every 5m" });
    expect(r({ method: "setStatus", statusKey: "loop" })).toEqual({ type: "porcupine_ui_status", key: "loop", text: null });
    expect(r({ method: "setWidget", widgetKey: "todo", widgetLines: ["a", "b"] })).toEqual({ type: "porcupine_ui_widget", key: "todo", lines: ["a", "b"] });
    expect(r({ method: "setWidget", widgetKey: "todo" })).toEqual({ type: "porcupine_ui_widget", key: "todo", lines: null });
    expect(r({ method: "setTitle", title: "pi - x" })).toEqual({ type: "porcupine_ui_title", title: "pi - x" });
  });

  it("drops component widgets with a log line and no response", () => {
    const d = handleUiRequest({ type: "extension_ui_request", id: "x", method: "setWidget", widgetKey: "k", widgetLines: [{}] });
    expect(d.event).toBeUndefined();
    expect(d.response).toBeUndefined();
    expect(d.log).toContain("dropped");
  });

  it("sends the generic cancel for unknown methods and logs them", () => {
    const d = handleUiRequest({ type: "extension_ui_request", id: "u", method: "brandNew" });
    expect(d.response).toStrictEqual({ type: "extension_ui_response", id: "u", cancelled: true });
    expect(d.log).toContain("unknown method brandNew");
  });
});

describe("UiStateStore", () => {
  it("keeps the latest state per key and drops cleared keys", () => {
    const s = new UiStateStore();
    s.apply({ type: "porcupine_ui_status", key: "a", text: "1" });
    s.apply({ type: "porcupine_ui_status", key: "a", text: "2" });
    s.apply({ type: "porcupine_ui_status", key: "b", text: "x" });
    s.apply({ type: "porcupine_ui_status", key: "b", text: null });
    s.apply({ type: "porcupine_ui_widget", key: "w", lines: ["l"] });
    s.apply({ type: "porcupine_ui_title", title: "T" });
    s.apply({ type: "message_end" });
    expect(s.snapshot()).toEqual([
      { type: "porcupine_ui_status", key: "a", text: "2" },
      { type: "porcupine_ui_widget", key: "w", lines: ["l"] },
      { type: "porcupine_ui_title", title: "T" },
    ]);
  });
});
