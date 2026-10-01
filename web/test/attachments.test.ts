// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  ATTACH_HEADER,
  buildAttachmentBlock,
  chipWarning,
  classify,
  estimateUsd,
  formatDuration,
  needsConfirm,
  showNotice,
  textOnly,
  renderChips,
  renderConfirm,
  sendWithAttachments,
  type Http,
  type Pending,
} from "../src/attachments.js";
import { loadShell } from "./dom.js";

const cfg = { confirmUsd: 0.5, confirmMinutes: 10, whisper: true, maxBytes: 2 * 1024 ** 3 };

describe("classify", () => {
  it("uses MIME first, then extension", () => {
    expect(classify({ name: "a.png", type: "image/png" })).toBe("image");
    expect(classify({ name: "memo.m4a", type: "" })).toBe("audio");
    expect(classify({ name: "memo.amr", type: "application/octet-stream" })).toBe("audio");
    expect(classify({ name: "clip.mov", type: "" })).toBe("video");
    expect(classify({ name: "spec.pdf", type: "" })).toBe("pdf");
    expect(classify({ name: "notes.md", type: "" })).toBe("text");
    expect(classify({ name: "photo.HEIC", type: "" })).toBe("image");
    expect(classify({ name: "blob", type: "" })).toBe("file");
  });
});

describe("chipWarning", () => {
  it("leaves vision to the modal and flags size and whisper", () => {
    expect(chipWarning("image")).toBeUndefined();
    expect(chipWarning("audio", 3 * 1024 ** 3)).toBe("Too large (max 2.0 GB)");
    expect(chipWarning("audio", 10, 100, false)).toMatch(/whisper/);
  });
});

describe("textOnly", () => {
  it("is true only for a known model without image input", () => {
    expect(textOnly({ input: ["text"] })).toBe(true);
    expect(textOnly({ input: ["text", "image"] })).toBe(false);
    expect(textOnly(null)).toBe(false);
  });
});

describe("showNotice", () => {
  it("opens a dialog, runs the action and removes itself", () => {
    let ran = false;
    const dlg = showNotice("T", "B", [{ label: "Go", run: () => (ran = true) }]);
    expect(document.body.contains(dlg)).toBe(true);
    expect(dlg.querySelector("h2")?.textContent).toBe("T");
    (dlg.querySelector("button") as HTMLButtonElement).click();
    dlg.dispatchEvent(new Event("close"));
    expect(ran).toBe(true);
    expect(document.body.contains(dlg)).toBe(false);
  });
});

describe("estimate and confirm rules", () => {
  it("estimateUsd uses the input price and image tokens", () => {
    expect(estimateUsd({ imageCount: 1, textTokens: 400, maxDurationSec: 0 }, { cost: { input: 3 } })).toBeCloseTo((2000 * 3) / 1e6);
    expect(estimateUsd({ imageCount: 1, textTokens: 0, maxDurationSec: 0 }, { cost: {} })).toBeNull();
  });
  it("needsConfirm: neither, cost only, length only, both, unknown cost", () => {
    const short = { imageCount: 0, textTokens: 0, maxDurationSec: 60 };
    const long = { imageCount: 0, textTokens: 0, maxDurationSec: 601 };
    expect(needsConfirm(short, 0.1, cfg)).toBe(false);
    expect(needsConfirm(short, 0.6, cfg)).toBe(true);
    expect(needsConfirm(long, 0.1, cfg)).toBe(true);
    expect(needsConfirm(long, 0.6, cfg)).toBe(true);
    expect(needsConfirm(short, null, cfg)).toBe(false);
    expect(needsConfirm(long, null, cfg)).toBe(true);
  });
});

describe("buildAttachmentBlock", () => {
  it("produces the exact block", () => {
    const d = "/h/.local/share/porcupine/uploads/s/u";
    const out = buildAttachmentBlock("summarize this", [
      { id: "1", kind: "audio", name: "voice-memo.m4a", durationSec: 252, artifacts: { transcript: `${d}1/transcript.txt` }, notes: [] },
      {
        id: "2",
        kind: "video",
        name: "demo.mp4",
        durationSec: 123,
        artifacts: { transcript: `${d}2/transcript.txt`, frames: [`${d}2/frames/frame-0001.png`, `${d}2/frames/frame-0002.png`] },
        notes: [],
      },
      { id: "3", kind: "pdf", name: "spec.pdf", pages: 12, artifacts: { text: `${d}3/text.txt`, pages: [`${d}3/pages/page-03.png`] }, notes: [] },
      { id: "4", kind: "image", name: "photo.jpg", original: `${d}4/photo.jpg`, artifacts: {}, notes: [] },
      { id: "5", kind: "audio", name: "x.ogg", error: "whisper missing" },
    ]);
    expect(out).toBe(
      [
        "summarize this",
        "",
        ATTACH_HEADER,
        `- voice-memo.m4a (audio, 4m12s): transcript ${d}1/transcript.txt`,
        `- demo.mp4 (video, 2m03s): transcript ${d}2/transcript.txt; 2 frames in ${d}2/frames/ (frame-0001.png is t=0s, one every 10s)`,
        `- spec.pdf (pdf, 12 pages): text ${d}3/text.txt; image-only pages rendered: ${d}3/pages/page-03.png`,
        `- photo.jpg (image): ${d}4/photo.jpg`,
        "- x.ogg: could not be processed (whisper missing)",
      ].join("\n"),
    );
    expect(formatDuration(3725)).toBe("1h02m05s");
  });
});

describe("DOM", () => {
  it("chips render and remove", () => {
    loadShell();
    const box = document.getElementById("attachments") as HTMLElement;
    const onRemove = vi.fn();
    const pending: Pending[] = [{ file: new File(["abc"], "a.png", { type: "image/png" }), kind: "image", warn: "Too large" }];
    renderChips(box, pending, onRemove);
    expect(box.hidden).toBe(false);
    const chip = box.querySelector(".attach-chip") as HTMLElement;
    expect(chip.dataset.warn).toBe("true");
    expect(chip.querySelector(".chip-name")?.textContent).toBe("a.png");
    (chip.querySelector(".chip-remove") as HTMLButtonElement).click();
    expect(onRemove).toHaveBeenCalledWith(0);
    renderChips(box, [], onRemove);
    expect(box.hidden).toBe(true);
  });

  it("the attach button sits left of the textarea", () => {
    loadShell();
    const form = document.getElementById("composer") as HTMLElement;
    const kids = Array.from(form.children).map((c) => c.id);
    expect(kids.indexOf("attach")).toBeLessThan(kids.indexOf("input"));
  });

  it("confirm card needs two clicks", async () => {
    loadShell();
    const card = document.getElementById("attach-confirm") as HTMLElement;
    let result: boolean | undefined;
    const p = renderConfirm(card, { usd: 1.234, durationSec: 900, frames: 0, pages: 0 }).then((r) => (result = r));
    expect(card.hidden).toBe(false);
    expect(card.textContent).toContain("about $1.23");
    (card.querySelector('[data-step="1"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(result).toBeUndefined();
    const spend = card.querySelector('[data-step="2"]') as HTMLButtonElement;
    expect(spend.textContent).toBe("Spend ~$1.23");
    expect(document.activeElement).toBe(spend);
    spend.click();
    await p;
    expect(result).toBe(true);
    expect(card.hidden).toBe(true);
  });

  it("cancel resolves false", async () => {
    loadShell();
    const card = document.getElementById("attach-confirm") as HTMLElement;
    const p = renderConfirm(card, { usd: null, durationSec: 900, frames: 0, pages: 0 });
    (card.querySelector(".secondary") as HTMLButtonElement).click();
    expect(await p).toBe(false);
  });
});

describe("sendWithAttachments", () => {
  function fakeHttp(maxDurationSec: number): Http {
    return {
      getConfig: vi.fn(),
      upload: vi.fn(async (_s: string, f: File, prog: (n: number) => void) => {
        prog(40);
        return { id: "u1", kind: "audio" as const, name: f.name, size: f.size, path: "/x/u1/m.m4a", probe: { durationSec: maxDurationSec } };
      }),
      estimate: vi.fn(async () => {
        const e = { imageCount: 0, textTokens: 200, maxDurationSec };
        return { uploads: [{ id: "u1", ...e }], total: e };
      }),
      process: vi.fn(async () => ({
        results: [{ id: "u1", kind: "audio" as const, name: "m.m4a", original: "/x/u1/m.m4a", artifacts: { transcript: "/x/u1/transcript.txt" }, notes: [] }],
      })),
    };
  }
  const base = (h: Http, confirm: () => Promise<boolean>) => ({
    session: "s",
    message: "summarize this",
    pending: [{ file: new File(["x"], "m.m4a"), kind: "audio" as const }],
    model: { id: "m", provider: "p", cost: { input: 1 } },
    http: h,
    config: cfg,
    rerender: vi.fn(),
    status: vi.fn(),
    confirm,
  });

  it("skips the card under thresholds and builds the message", async () => {
    const h = fakeHttp(60);
    const confirm = vi.fn(async () => true);
    const out = await sendWithAttachments(base(h, confirm));
    expect(confirm).not.toHaveBeenCalled();
    expect(out).toBe(`summarize this\n\n${ATTACH_HEADER}\n- m.m4a (audio, 1m00s): transcript /x/u1/transcript.txt`);
  });

  it("asks over the length rule and stops on cancel", async () => {
    const h = fakeHttp(700);
    const confirm = vi.fn(async () => false);
    expect(await sendWithAttachments(base(h, confirm))).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(h.process).not.toHaveBeenCalled();
  });
});
