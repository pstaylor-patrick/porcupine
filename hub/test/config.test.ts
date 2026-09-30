import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/server/config.js";
import { parseEnv } from "../src/server/env-file.js";

const secrets = { PORCUPINE_RPC_PASSWORD: "pw", PORCUPINE_COOKIE_SECRET: "a".repeat(64) };
const load = (env: NodeJS.ProcessEnv, s: Record<string, string> = secrets) =>
  loadConfig({ env: { PORCUPINE_RUNTIME_DIR: "/tmp/x", ...env }, home: "/h", readEnv: () => s });

describe("parseEnv", () => {
  it("handles comments, export, quotes and CRLF", () => {
    const text = ["# c", "export A=1", 'B="two words"', "C='x#y'", "D=plain # trailing", "E=", "bad line", "F=v\r"].join("\n");
    expect(parseEnv(text)).toEqual({ A: "1", B: "two words", C: "x#y", D: "plain", E: "", F: "v" });
  });
});

describe("loadConfig", () => {
  it("defaults to loopback 8787, prod origin only, 30 day TTL", () => {
    const c = load({});
    expect(c).toMatchObject({ host: "127.0.0.1", port: 8787, dev: false, cookieTtlSec: 2592000 });
    expect(c.origins).toEqual(["https://porcupine.pstaylor.net"]);
  });
  it("dev mode adds localhost origins", () => {
    expect(load({ PORCUPINE_DEV: "1" }).origins).toContain("http://localhost:8787");
  });
  it("refuses dev mode on a non-loopback address", () => {
    expect(() => load({ PORCUPINE_DEV: "1", PORCUPINE_HUB_ADDR: "0.0.0.0:8787" })).toThrow(ConfigError);
  });
  it("refuses to start without a cookie secret and prints how to make one", () => {
    expect(() => load({}, { PORCUPINE_RPC_PASSWORD: "pw" })).toThrow(/openssl rand -hex 32/);
  });
});
