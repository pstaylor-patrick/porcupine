// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { StatusPanel } from "../src/status-panel.js";

describe("StatusPanel", () => {
  it("renders chips and widgets as text and hides when empty", () => {
    const p = new StatusPanel();
    const root = document.createElement("div");
    p.render(root);
    expect(root.hidden).toBe(true);
    p.apply({ type: "porcupine_ui_status", key: "loop", text: "<b>every 5m</b>" });
    p.apply({ type: "porcupine_ui_widget", key: "todo", lines: ["[ ] one", "[x] two"] });
    p.render(root);
    expect(root.hidden).toBe(false);
    expect(root.querySelector(".status-chip")?.textContent).toBe("<b>every 5m</b>");
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector(".status-widget")?.textContent).toBe("[ ] one\n[x] two");
    p.apply({ type: "porcupine_ui_status", key: "loop", text: null });
    p.apply({ type: "porcupine_ui_widget", key: "todo", lines: null });
    p.render(root);
    expect(root.hidden).toBe(true);
  });

  it("tracks the title and replaces state from a snapshot", () => {
    const p = new StatusPanel();
    p.apply({ type: "porcupine_ui_status", key: "old", text: "x" });
    expect(p.apply({ type: "porcupine_ui_title", title: "pi - proj" })).toBe(true);
    expect(p.title).toBe("pi - proj");
    p.apply({ type: "porcupine_ui_snapshot", events: [{ type: "porcupine_ui_status", key: "new", text: "y" }] });
    expect([...p.status]).toEqual([["new", "y"]]);
    expect(p.title).toBeNull();
    expect(p.apply({ type: "message_end" })).toBe(false);
  });
});
