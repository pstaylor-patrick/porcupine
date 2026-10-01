import { describe, expect, it } from "vitest";
import { autocompactCommand, contextPercent, contextText, parseContextUsage } from "../src/context.js";

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
  });
});
