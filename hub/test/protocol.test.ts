import { describe, expect, it } from "vitest";
import { ALLOWED_PI_COMMANDS, isAllowedCommand } from "../src/shared/protocol.js";

describe("ALLOWED_PI_COMMANDS", () => {
  it("allows the session plumbing commands", () => {
    for (const c of [
      "get_session_stats",
      "set_auto_compaction",
      "get_commands",
      "fork",
      "clone",
      "switch_session",
      "get_tree",
      "set_session_name",
      "abort_retry",
      "prompt",
      "compact",
    ]) {
      expect(isAllowedCommand(c), c).toBe(true);
    }
  });

  it("never allows bash or unknown commands", () => {
    expect(isAllowedCommand("bash")).toBe(false);
    expect(isAllowedCommand("abort_bash")).toBe(false);
    expect(isAllowedCommand(42)).toBe(false);
    expect(ALLOWED_PI_COMMANDS).not.toContain("bash");
  });
});
