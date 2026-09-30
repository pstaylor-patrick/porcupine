import { describe, expect, it } from "vitest";
import { handleUiRequest } from "../src/cli/ui-autocancel.js";

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

  it("ignores other fire-and-forget methods", () => {
    for (const method of ["setStatus", "setWidget", "setTitle", "set_editor_text"]) {
      expect(handleUiRequest({ type: "extension_ui_request", id: "x", method })).toEqual({});
    }
  });

  it("sends the generic cancel for unknown methods and logs them", () => {
    const d = handleUiRequest({ type: "extension_ui_request", id: "u", method: "brandNew" });
    expect(d.response).toStrictEqual({ type: "extension_ui_response", id: "u", cancelled: true });
    expect(d.log).toContain("unknown method brandNew");
  });
});
