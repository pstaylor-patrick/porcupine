// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ATTACH_HEADER } from "../src/attachments.js";
import { chipLabel, itemsFromQueue, parseQueue, planRewrite, renderQueueChips, requeuePlan, restoreText, targetAt } from "../src/queue.js";

const q = { steering: ["s1"], followUp: ["f1", "f2"] };

describe("itemsFromQueue", () => {
  it("orders steering, followUp, then held as pending", () => {
    expect(itemsFromQueue(q, ["h"])).toEqual([
      { kind: "steer", text: "s1" },
      { kind: "followUp", text: "f1" },
      { kind: "followUp", text: "f2" },
      { kind: "followUp", text: "h", pending: true },
    ]);
  });
});

describe("parseQueue", () => {
  it("keeps strings and defaults missing arrays", () => {
    expect(parseQueue({ type: "queue_update", steering: ["a", 3] })).toEqual({ steering: ["a"], followUp: [] });
  });
});

describe("requeuePlan", () => {
  const items = itemsFromQueue(q, ["h"]);
  it("drops the removed item and held items, preserving order", () => {
    expect(requeuePlan(items, 1)).toEqual([
      { kind: "steer", text: "s1" },
      { kind: "followUp", text: "f2" },
    ]);
  });
  it("promotes the removed item to a leading steer", () => {
    expect(requeuePlan(items, 2, true)).toEqual([
      { kind: "steer", text: "f2" },
      { kind: "steer", text: "s1" },
      { kind: "followUp", text: "f1" },
    ]);
  });
  it("removes only one of duplicate texts", () => {
    const dup = itemsFromQueue({ steering: [], followUp: ["x", "x"] }, []);
    expect(requeuePlan(dup, 0)).toEqual([{ kind: "followUp", text: "x" }]);
  });
});

describe("restoreText", () => {
  it("joins steering, followUp and draft with blank lines, skipping empties", () => {
    expect(restoreText(q, "draft")).toBe("s1\n\nf1\n\nf2\n\ndraft");
    expect(restoreText({ steering: [], followUp: [] }, "  ")).toBe("");
  });
});

describe("chipLabel", () => {
  it("collapses the attachment block to file names", () => {
    const text = `look\n\n${ATTACH_HEADER}\n- a.png (image, 1 KB): /tmp/uploads/sess/123e4567-e89b-12d3-a456-426614174000/a.png`;
    expect(chipLabel(text)).toEqual({ body: "look", files: ["a.png"] });
  });
  it("passes plain text through", () => {
    expect(chipLabel("hi")).toEqual({ body: "hi", files: [] });
  });
});

describe("renderQueueChips", () => {
  it("renders one chip per item with markers and hides when empty", () => {
    const box = document.createElement("ul");
    renderQueueChips(box, itemsFromQueue({ steering: ["s"], followUp: [] }, ["h"]));
    expect(box.hidden).toBe(false);
    const chips = box.querySelectorAll(".queue-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toBe("steers");
    expect(chips[1]?.textContent).toContain("waiting for compaction");
    renderQueueChips(box, []);
    expect(box.hidden).toBe(true);
    expect(box.children).toHaveLength(0);
  });
});

describe("planRewrite", () => {
  it("maps by index within kind, then first text match, else requeues unchanged", () => {
    const cleared = { steering: ["s"], followUp: ["x", "y", "x"] };
    expect(planRewrite(cleared, { kind: "followUp", index: 2, text: "x" })).toEqual({
      next: [
        { kind: "steer", text: "s" },
        { kind: "followUp", text: "x" },
        { kind: "followUp", text: "y" },
      ],
      removed: "x",
    });
    expect(planRewrite(cleared, { kind: "followUp", index: 1, text: "x" }).next.map((i) => i.text)).toEqual(["s", "y", "x"]);
    const gone = planRewrite(cleared, { kind: "followUp", index: 0, text: "q" });
    expect(gone.removed).toBeNull();
    expect(gone.next).toHaveLength(4);
  });
  it("targetAt counts within kind and skips held items", () => {
    const items = itemsFromQueue({ steering: ["s"], followUp: ["a", "b"] }, ["h"]);
    expect(targetAt(items, 2)).toEqual({ kind: "followUp", index: 1, text: "b" });
    expect(targetAt(items, 3)).toBeNull();
  });
});
