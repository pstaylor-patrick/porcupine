import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUBAGENT_ANSWER, subagentResult } from "../src/extension/ask-user-question.js";
import { discoverAgents, parseFrontmatter, parseToolList } from "../src/extension/subagent/agents.js";
import { buildSubagentArgs, buildSubagentEnv, resolveChildModel } from "../src/extension/subagent/child.js";
import { subagentMessages } from "../src/server/usage/subagent.js";

const NONE = { OPENROUTER_API_KEY: "sk-or-test" };
const BOTH = { ...NONE, ANTHROPIC_API_KEY: "ak", OPENAI_API_KEY: "sk-test" };
const PARENT = { provider: "openrouter", id: "deepseek/deepseek-v4-pro" };

describe("resolveChildModel", () => {
  it("inherits the parent model when the agent sets none", () => {
    expect(resolveChildModel(undefined, PARENT, NONE)).toEqual({ ok: true, model: PARENT });
  });
  it("routes vendor/model like PORCUPINE_MODEL", () => {
    expect(resolveChildModel("google/gemini-3-pro", PARENT, NONE)).toEqual({ ok: true, model: { provider: "openrouter", id: "google/gemini-3-pro" } });
    expect(resolveChildModel("anthropic/claude-opus-5-5", PARENT, BOTH)).toEqual({ ok: true, model: { provider: "anthropic", id: "claude-opus-5-5" } });
  });
  it("never sends Anthropic or OpenAI through OpenRouter", () => {
    expect(resolveChildModel("openrouter/anthropic/claude-opus-5-5", PARENT, BOTH).ok).toBe(false);
    expect(resolveChildModel("openrouter/openai/gpt-6", PARENT, NONE).ok).toBe(false);
  });
  it("hides direct providers without their key", () => {
    expect(resolveChildModel("anthropic/claude-opus-5-5", PARENT, NONE).ok).toBe(false);
    expect(resolveChildModel("openai/gpt-6", PARENT, NONE).ok).toBe(false);
  });
  it("puts a bare id on the parent's provider", () => {
    expect(resolveChildModel("claude-haiku-5", { provider: "anthropic", id: "x" }, BOTH)).toEqual({
      ok: true,
      model: { provider: "anthropic", id: "claude-haiku-5" },
    });
  });
  it("fails without any model", () => {
    expect(resolveChildModel(undefined, undefined, NONE).ok).toBe(false);
  });
});

describe("buildSubagentEnv", () => {
  const env = {
    ...BOTH,
    PATH: "/bin",
    PORCUPINE_RPC_PASSWORD: "pw",
    PORCUPINE_COOKIE_SECRET: "cs",
    PORCUPINE_CF_SESSION_ID: "old",
  };
  it("keeps only the child's provider key and drops porcupine secrets", () => {
    const out = buildSubagentEnv(env, "anthropic", "parent-1");
    expect(out.ANTHROPIC_API_KEY).toBe("ak");
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.OPENROUTER_API_KEY).toBeUndefined();
    expect(out.PORCUPINE_RPC_PASSWORD).toBeUndefined();
    expect(out.PORCUPINE_COOKIE_SECRET).toBeUndefined();
    expect(out.PATH).toBe("/bin");
  });
  it("carries the parent's cf session id and marks the child", () => {
    const out = buildSubagentEnv(env, "openrouter", "parent-1");
    expect(out.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.PORCUPINE_CF_SESSION_ID).toBe("parent-1");
    expect(out.PORCUPINE_SUBAGENT).toBe("1");
  });
  it("does not mutate the input", () => {
    buildSubagentEnv(env, "openai", "p");
    expect(env.PORCUPINE_RPC_PASSWORD).toBe("pw");
  });
});

describe("buildSubagentArgs", () => {
  it("runs pi headless with the hooks extension and routed model", () => {
    const args = buildSubagentArgs({
      model: PARENT,
      thinking: "low",
      tools: ["read", "bash"],
      extensions: ["/x/claude-hooks/index.js"],
      systemPromptFile: "/tmp/p.md",
      task: "do it",
    });
    expect(args).toEqual([
      "--mode", "json", "-p", "--no-session",
      "--extension", "/x/claude-hooks/index.js",
      "--provider", "openrouter", "--model", "deepseek/deepseek-v4-pro",
      "--thinking", "low",
      "--tools", "read,bash",
      "--append-system-prompt", "/tmp/p.md",
      "Task: do it",
    ]);
  });
});

describe("agents", () => {
  it("parses frontmatter and tool lists", () => {
    const { frontmatter, body } = parseFrontmatter('---\nname: scout\ndescription: "Finds things"\ntools: [read, grep]\n---\nBody');
    expect(frontmatter).toEqual({ name: "scout", description: "Finds things", tools: "[read, grep]" });
    expect(body).toBe("Body");
    expect(parseToolList(frontmatter.tools)).toEqual(["read", "grep"]);
    expect(parseToolList("read, bash")).toEqual(["read", "bash"]);
  });
  it("discovers user agents plus the built-in general-purpose agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "porcupine-agents-"));
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "scout.md"), "---\nname: scout\ndescription: d\nmodel: google/gemini-3-pro\n---\nYou scout.");
    writeFileSync(join(dir, "agents", "bad.md"), "no frontmatter");
    const { agents } = discoverAgents(dir, "user", dir);
    expect(agents.map((a) => a.name).sort()).toEqual(["general-purpose", "scout"]);
    expect(agents.find((a) => a.name === "scout")?.model).toBe("google/gemini-3-pro");
  });
});

describe("subagent usage capture", () => {
  it("extracts child assistant messages from tool details", () => {
    const a = { role: "assistant", provider: "openrouter", model: "m", usage: { input: 1 } };
    const result = { details: { results: [{ messages: [a, { role: "toolResult" }] }, { messages: [a] }, {}] } };
    expect(subagentMessages(result)).toEqual([a, a]);
    expect(subagentMessages(null)).toEqual([]);
    expect(subagentMessages({ details: {} })).toEqual([]);
  });
});

describe("ask_user_question in a subagent", () => {
  it("tells the child to decide itself", () => {
    const r = subagentResult([{ question: "q", header: "h", options: [] }]);
    expect(r.content[0]?.text).toBe(SUBAGENT_ANSWER);
    expect(r.details.answers).toBeNull();
  });
});
