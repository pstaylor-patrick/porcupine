import { describe, expect, it } from "vitest";
import { fromB64u, pushHint } from "../src/push.js";

describe("push helpers", () => {
  it("decodes base64url keys", () => {
    expect([...fromB64u("AQID_w")]).toEqual([1, 2, 3, 255]);
  });
  it("explains the iOS home-screen requirement when unsupported", () => {
    expect(pushHint("unsupported")).toMatch(/home screen/);
  });
});
