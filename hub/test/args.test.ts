import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING,
  buildChildEnv,
  buildPiArgs,
  resolveDefaultProvider,
  resolveDefaults,
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
  it("uses the defaults passed by the caller", () => {
    expect(buildPiArgs([], [], { provider: "openrouter", model: "m/x" }).slice(2, 6)).toEqual([
      "--provider", "openrouter", "--model", "m/x",
    ]);
  });
  it("injects no provider or model when the user passes --provider", () => {
    const out = buildPiArgs(["--provider", "openai"], [], { provider: "openrouter", model: "m/x" });
    expect(out).not.toContain("openrouter");
    expect(out).not.toContain("m/x");
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
    OPENROUTER_API_KEY: "ok",
    PORCUPINE_RPC_PASSWORD: "hunter2",
    PORCUPINE_COOKIE_SECRET: "c",
  };
  it("maps VERCEL_AI_GATEWAY_API_KEY to AI_GATEWAY_API_KEY", () => {
    expect(buildChildEnv({ PATH: "/bin" }, fileEnv).AI_GATEWAY_API_KEY).toBe("vk");
  });
  it("passes OPENROUTER_API_KEY from the env file", () => {
    expect(buildChildEnv({ PATH: "/bin" }, fileEnv).OPENROUTER_API_KEY).toBe("ok");
    expect(buildChildEnv({ OPENROUTER_API_KEY: "mine" }, fileEnv).OPENROUTER_API_KEY).toBe("mine");
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

describe("OpenRouter key shim", () => {
  it("passes OPENROUTER_API_KEY from the process env", () => {
    expect(buildChildEnv({ OPENROUTER_API_KEY: "sk-or-test" }, {}).OPENROUTER_API_KEY).toBe("sk-or-test");
  });
  it("moves an sk-or- OPENAI_API_KEY to OPENROUTER_API_KEY", () => {
    const fromFile = buildChildEnv({}, { OPENAI_API_KEY: "sk-or-test" });
    expect(fromFile.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(fromFile.OPENAI_API_KEY).toBeUndefined();
    const fromProc = buildChildEnv({ OPENAI_API_KEY: "sk-or-test" }, {});
    expect(fromProc.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(fromProc.OPENAI_API_KEY).toBeUndefined();
  });
  it("drops an sk-or- OPENAI_API_KEY and keeps a real OpenRouter key", () => {
    const env = buildChildEnv({ OPENAI_API_KEY: "sk-or-other" }, { OPENROUTER_API_KEY: "sk-or-test" });
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
  it("leaves a real OpenAI key alone", () => {
    const env = buildChildEnv({ OPENAI_API_KEY: "sk-test" }, {});
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });
});

describe("resolveDefaultProvider", () => {
  it("honours PORCUPINE_PROVIDER", () => {
    expect(resolveDefaultProvider({ PORCUPINE_PROVIDER: "vercel-ai-gateway", OPENROUTER_API_KEY: "sk-or-test" })).toBe(
      "vercel-ai-gateway",
    );
  });
  it("prefers openrouter when its key is set", () => {
    expect(resolveDefaultProvider({ OPENROUTER_API_KEY: "sk-or-test", AI_GATEWAY_API_KEY: "vk" })).toBe("openrouter");
  });
  it("falls back to vercel-ai-gateway", () => {
    expect(resolveDefaultProvider({})).toBe("vercel-ai-gateway");
  });
  it("applies a PORCUPINE_MODEL override", () => {
    expect(resolveDefaults({ PORCUPINE_MODEL: "x/y" }).model).toBe("x/y");
    expect(resolveDefaults({}).model).toBe(DEFAULT_MODEL);
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
