import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING,
  buildChildEnv,
  buildPiArgs,
  parseCliArgs,
  parseEnvFile,
  resolveName,
  slugify,
} from "../src/cli/args.js";
import { resolveRuntimeDir } from "../src/shared/paths.js";

describe("buildPiArgs", () => {
  it("adds the default provider, model and thinking level when none is given", () => {
    expect(buildPiArgs([])).toEqual([
      "--mode", "rpc", "--provider", DEFAULT_PROVIDER, "--model", DEFAULT_MODEL, "--thinking", DEFAULT_THINKING,
    ]);
  });
  it("does not add a default the user overrode", () => {
    expect(buildPiArgs(["--model", "x/y"])).toEqual(["--mode", "rpc", "--thinking", "low", "--model", "x/y"]);
    expect(buildPiArgs(["--provider=openai", "--thinking=high"])).toEqual(["--mode", "rpc", "--provider=openai", "--thinking=high"]);
  });
  it("keeps other user args after the defaults", () => {
    expect(buildPiArgs(["--thinking", "high"]).slice(-2)).toEqual(["--thinking", "high"]);
  });
});

describe("parseCliArgs", () => {
  it("pulls --name and passes the rest through", () => {
    expect(parseCliArgs(["--name", "x", "--model", "m"])).toEqual({ name: "x", piArgs: ["--model", "m"] });
    expect(parseCliArgs(["--name=y", "--", "--name", "z"])).toEqual({ name: "y", piArgs: ["--name", "z"] });
  });
  it("rejects --name without a value", () => {
    expect(() => parseCliArgs(["--name"])).toThrow();
  });
});

describe("buildChildEnv", () => {
  const fileEnv = {
    VERCEL_AI_GATEWAY_API_KEY: "vk",
    PORCUPINE_RPC_PASSWORD: "hunter2",
    PORCUPINE_COOKIE_SECRET: "c",
  };
  it("maps VERCEL_AI_GATEWAY_API_KEY to AI_GATEWAY_API_KEY", () => {
    expect(buildChildEnv({ PATH: "/bin" }, fileEnv).AI_GATEWAY_API_KEY).toBe("vk");
  });
  it("keeps an existing AI_GATEWAY_API_KEY", () => {
    expect(buildChildEnv({ AI_GATEWAY_API_KEY: "mine" }, fileEnv).AI_GATEWAY_API_KEY).toBe("mine");
  });
  it("never passes the password or cookie secret", () => {
    const env = buildChildEnv({ PORCUPINE_RPC_PASSWORD: "hunter2", PORCUPINE_COOKIE_SECRET: "c" }, fileEnv);
    expect(env.PORCUPINE_RPC_PASSWORD).toBeUndefined();
    expect(env.PORCUPINE_COOKIE_SECRET).toBeUndefined();
    expect(Object.values(env)).not.toContain("hunter2");
  });
});

describe("resolveName", () => {
  it("prefers --name", () => {
    expect(resolveName({ explicit: "a", env: { TMUX: "1" }, cwd: "/x/repo", tmuxName: () => "s:w" })).toBe("a");
  });
  it("uses tmux session:window inside tmux", () => {
    expect(resolveName({ explicit: null, env: { TMUX: "1" }, cwd: "/x/repo", tmuxName: () => "s:w" })).toBe("s:w");
  });
  it("falls back to the cwd basename", () => {
    expect(resolveName({ explicit: null, env: {}, cwd: "/x/repo", tmuxName: () => "s:w" })).toBe("repo");
    expect(resolveName({ explicit: null, env: { TMUX: "1" }, cwd: "/x/repo", tmuxName: () => null })).toBe("repo");
  });
  it("slugifies for ids", () => {
    expect(slugify("Main:Pi Work")).toBe("main-pi-work");
    expect(slugify("::")).toBe("session");
  });
});

describe("parseEnvFile", () => {
  it("parses keys, quotes and comments", () => {
    expect(parseEnvFile("# c\nA=1\nexport B=\"two words\"\nC='x'\nbad line\n")).toEqual({ A: "1", B: "two words", C: "x" });
  });
});

describe("resolveRuntimeDir", () => {
  it("honours the override, then XDG, then home", () => {
    expect(resolveRuntimeDir({ env: { PORCUPINE_RUNTIME_DIR: "/o", XDG_RUNTIME_DIR: "/x" } })).toBe("/o");
    expect(resolveRuntimeDir({ env: { XDG_RUNTIME_DIR: "/x" }, isWritable: () => true })).toBe("/x/porcupine");
    expect(resolveRuntimeDir({ env: { XDG_RUNTIME_DIR: "/x" }, home: "/h", isWritable: () => false })).toBe(
      "/h/.porcupine/run",
    );
    expect(resolveRuntimeDir({ env: {}, home: "/h" })).toBe("/h/.porcupine/run");
  });
});
