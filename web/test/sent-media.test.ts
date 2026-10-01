// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildAttachmentBlock, parseSentMessage } from "../src/attachments.js";
import { renderItem } from "../src/render.js";

const U = "0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b";
const V = "1c7a4d2f-3b5e-4f9a-8b2c-4d6e8f0a2b3c";
const d = "/h/.local/share/porcupine/uploads/sess-1";
const sent = buildAttachmentBlock("look at these", [
  { id: U, kind: "image", name: "photo.jpg", original: `${d}/${U}/photo.jpg`, artifacts: {}, notes: [] },
  { id: V, kind: "video", name: "clip.mov", durationSec: 5, artifacts: { transcript: `${d}/${V}/transcript.txt` }, notes: [] },
  { id: "x", kind: "audio", name: "bad.ogg", error: "whisper missing" },
]);

describe("parseSentMessage", () => {
  it("splits the user's text from the attachments", () => {
    expect(parseSentMessage(sent)).toEqual({
      text: "look at these",
      attachments: [
        { name: "photo.jpg", kind: "image", session: "sess-1", id: U },
        { name: "clip.mov", kind: "video", session: "sess-1", id: V },
      ],
    });
  });
  it("leaves plain text alone", () => {
    expect(parseSentMessage("hi")).toEqual({ text: "hi", attachments: [] });
  });
});

describe("user message media", () => {
  it("renders the media inline and hides the host paths", () => {
    const node = renderItem({ kind: "user", text: sent, msgKey: "k" } as never, {} as never, new Set());
    expect(node.textContent).not.toContain("/uploads/");
    expect(node.textContent).toContain("look at these");
    expect(node.querySelector("img")?.getAttribute("src")).toBe(`/api/uploads/file?session=sess-1&id=${U}`);
    const video = node.querySelector("video");
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.getAttribute("src")).toBe(`/api/uploads/file?session=sess-1&id=${V}#t=0.1`);
  });
});
