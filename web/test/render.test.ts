// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { formatText, OUTPUT_LIMIT, TranscriptView } from "../src/render.js";
import { applyEvent, emptyTranscript } from "../src/transcript.js";

const EVIL = '<img src=x onerror="window.__pwned=1">';

describe("render", () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement("div");
    document.body.append(root);
  });

  it("never inserts model text as HTML", () => {
    const t = emptyTranscript();
    applyEvent(t, { type: "message_start", message: { role: "user", content: EVIL, timestamp: 1 } });
    applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: EVIL } });
    applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: EVIL } });
    applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "```html\n" + EVIL + "\n```" } });
    applyEvent(t, { type: "tool_execution_end", toolCallId: "c", toolName: EVIL, result: { content: [{ type: "text", text: EVIL }] } });
    applyEvent(t, { type: "porcupine_notice", level: "warn", text: EVIL });
    new TranscriptView(root).render(t);
    expect(root.querySelector("img")).toBeNull();
    expect(root.innerHTML).not.toContain("<img");
    expect(root.textContent).toContain(EVIL);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("formats fenced code and inline code as text", () => {
    const frag = formatText("run `ls` now\n```sh\necho <b>\n```\nafter");
    root.append(frag);
    expect(root.querySelector("pre.code code")?.textContent).toBe("echo <b>");
    expect(root.querySelector(".prose code")?.textContent).toBe("ls");
    expect(root.querySelector("b")).toBeNull();
  });

  it("truncates long tool output with an expand button", () => {
    const t = emptyTranscript();
    const long = "x".repeat(OUTPUT_LIMIT + 100);
    applyEvent(t, { type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: { content: [{ type: "text", text: long }] } });
    new TranscriptView(root).render(t);
    const pre = root.querySelector(".tool-output pre");
    expect(pre?.textContent?.length).toBeLessThan(long.length);
    (root.querySelector(".tool-output button") as HTMLButtonElement).click();
    expect(pre?.textContent).toBe(long);
  });

  it("re-renders only changed items and keeps order", () => {
    const t = emptyTranscript();
    applyEvent(t, { type: "message_start", message: { role: "user", content: "one", timestamp: 1 } });
    applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" } });
    const view = new TranscriptView(root);
    view.render(t);
    const userNode = root.firstElementChild;
    applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b" } });
    view.render(t);
    expect(root.firstElementChild).toBe(userNode);
    expect(root.lastElementChild?.textContent).toBe("ab");
    expect(root.children).toHaveLength(2);
  });
});
