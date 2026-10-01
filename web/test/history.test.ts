// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { flattenTree, renderHistory } from "../src/history.js";

const msg = (id: string, role: string, text: string, children: unknown[] = []) => ({
  entry: { type: "message", id, message: { role, content: [{ type: "text", text }] } },
  children,
});

describe("history", () => {
  const data = {
    tree: [msg("u1", "user", "hello", [msg("a1", "assistant", "hi", [msg("u2", "user", "branch one"), msg("u3", "user", "branch two", [{ entry: { type: "custom", id: "c1" }, children: [] }])])])],
    leafId: "c1",
  };

  it("indents only at branch points and marks the current path", () => {
    const rows = flattenTree(data);
    expect(rows.map((r) => [r.id, r.depth, r.current])).toEqual([
      ["u1", 0, true],
      ["a1", 0, true],
      ["u2", 1, false],
      ["u3", 1, true],
    ]);
    expect(flattenTree(null)).toEqual([]);
  });

  it("renders fork buttons on user rows", () => {
    const root = document.createElement("ul");
    const forked: string[] = [];
    renderHistory(root, flattenTree(data), { fork: (id) => forked.push(id) });
    const buttons = root.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    (buttons[2] as HTMLButtonElement).click();
    expect(forked).toEqual(["u3"]);
    renderHistory(root, [], { fork: () => undefined });
    expect(root.textContent).toBe("No messages yet");
  });
});
