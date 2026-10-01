import { describe, expect, it } from "vitest";
import { autocompactCommand, contextPercent, defaultThreshold, groupDigits, contextText, parseContextUsage } from "../src/context.js";

describe("context meter", () => {
  it("parses and formats stats", () => {
    const c = parseContextUsage({ contextUsage: { tokens: 1200, contextWindow: 128000, percent: 0.94 } });
    expect(contextText(c)).toBe("1,200 / 128,000 tokens");
    expect(contextPercent(c)).toBe("1%");
    expect(parseContextUsage({})).toBeNull();
    expect(contextText(null)).toBe("unknown");
  });
  it("builds /autocompact commands", () => {
    expect(autocompactCommand("", true)).toBe("/autocompact off");
    expect(autocompactCommand("", false)).toBe("/autocompact default");
    expect(autocompactCommand("150000", false)).toBe("/autocompact 150000");
    expect(autocompactCommand("1.5", false)).toBeNull();
    expect(autocompactCommand("250,000", false)).toBe("/autocompact 250000");
  });

  it("mirrors the hub's default threshold", () => {
    expect(defaultThreshold(1_048_576)).toBe(250_000);
    expect(defaultThreshold(200_000)).toBe(160_000);
    expect(defaultThreshold(undefined)).toBe(250_000);
  });

  it("groups digits with commas", () => {
    expect(groupDigits("250000")).toBe("250,000");
    expect(groupDigits("1,0000")).toBe("10,000");
    expect(groupDigits("12a3")).toBe("123");
    expect(groupDigits("")).toBe("");
  });
});
