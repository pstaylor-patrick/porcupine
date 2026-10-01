import { describe, expect, it } from "vitest";
import { estimateUpload, estimateUsd, frameCount, needsConfirm, sumEstimates } from "../src/server/uploads/estimate.js";

describe("estimateUpload", () => {
  it("audio: 200 tokens per started minute, no images", () => {
    expect(estimateUpload({ kind: "audio", size: 1 }, { durationSec: 252 })).toEqual({ imageCount: 0, textTokens: 1000, maxDurationSec: 252 });
  });
  it("video: transcript tokens plus one frame per 10 s capped at 60", () => {
    expect(estimateUpload({ kind: "video", size: 1 }, { durationSec: 15 })).toEqual({ imageCount: 2, textTokens: 200, maxDurationSec: 15 });
    expect(estimateUpload({ kind: "video", size: 1 }, { durationSec: 1200 }).imageCount).toBe(60);
    expect(frameCount(0)).toBe(1);
  });
  it("pdf: chars/4 plus empty pages as images", () => {
    expect(estimateUpload({ kind: "pdf", size: 1 }, { pages: 5, textChars: 4001, emptyPages: 2 })).toEqual({ imageCount: 2, textTokens: 1001, maxDurationSec: 0 });
  });
  it("image, text and file", () => {
    expect(estimateUpload({ kind: "image", size: 9e6 }, {})).toEqual({ imageCount: 1, textTokens: 0, maxDurationSec: 0 });
    expect(estimateUpload({ kind: "text", size: 400 }, {})).toEqual({ imageCount: 0, textTokens: 100, maxDurationSec: 0 });
    expect(estimateUpload({ kind: "file", size: 400 }, {})).toEqual({ imageCount: 0, textTokens: 0, maxDurationSec: 0 });
  });
});

describe("sumEstimates and thresholds", () => {
  const cfg = { confirmUsd: 0.5, confirmMinutes: 10 };
  it("sums counts and keeps the max duration", () => {
    expect(
      sumEstimates([
        { imageCount: 1, textTokens: 10, maxDurationSec: 30 },
        { imageCount: 2, textTokens: 5, maxDurationSec: 700 },
      ]),
    ).toEqual({ imageCount: 3, textTokens: 15, maxDurationSec: 700 });
    expect(sumEstimates([])).toEqual({ imageCount: 0, textTokens: 0, maxDurationSec: 0 });
  });
  it("prices at the input rate and confirms on cost or length", () => {
    const small = { imageCount: 1, textTokens: 400, maxDurationSec: 60 };
    expect(estimateUsd(small, 3)).toBeCloseTo(0.006);
    expect(estimateUsd(small, undefined)).toBeNull();
    expect(needsConfirm(small, 0.006, cfg)).toBe(false);
    expect(needsConfirm(small, 0.51, cfg)).toBe(true);
    expect(needsConfirm({ ...small, maxDurationSec: 601 }, 0.01, cfg)).toBe(true);
    expect(needsConfirm({ ...small, maxDurationSec: 601 }, null, cfg)).toBe(true);
    expect(needsConfirm(small, null, cfg)).toBe(false);
  });
});
