import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import claudeSkills from "../src/extension/claude-skills/index.js";
import { discoverSkills, skillPrompt, splitFrontmatter } from "../src/extension/claude-skills/skills.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "porcupine-skills-"));
  for (const [name, desc] of [
    ["cf:plan", "Plan a goal"],
    ["awslogin", '"Refresh AWS"'],
  ] as const) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# Body of ${name}\nUse AskUserQuestion.\n`);
  }
  mkdirSync(join(root, "empty"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("claude skills", () => {
  it("strips frontmatter and reads the description", () => {
    expect(splitFrontmatter("---\ndescription: hi there\n---\nbody")).toEqual({ description: "hi there", body: "body" });
    expect(splitFrontmatter("no frontmatter")).toEqual({ description: "", body: "no frontmatter" });
  });

  it("names commands after the skill directory and skips dirs without SKILL.md", () => {
    const skills = discoverSkills(root);
    expect(skills.map((s) => [s.name, s.description])).toEqual([
      ["awslogin", "Refresh AWS"],
      ["cf:plan", "Plan a goal"],
    ]);
  });

  it("builds a prompt with the skill dir, tool notes, body and args", () => {
    const plan = discoverSkills(root).find((s) => s.name === "cf:plan");
    if (!plan) throw new Error("cf:plan not discovered");
    const p = skillPrompt(plan, "  ship it ", { subagent: false });
    expect(p).not.toMatch(/^---/m);
    expect(p).toContain(`Its directory is ${join(root, "cf:plan")}`);
    expect(p).toContain("# Body of cf:plan");
    expect(p).toContain("ask_user_question");
    expect(p).toMatch(/Agent .*not available/);
    expect(p).toMatch(/Workflow: not supported/);
    expect(p.endsWith("Arguments: ship it")).toBe(true);
    expect(skillPrompt(plan, "", { subagent: true })).toContain("use the subagent tool");
  });

  it("registers a command per skill that sends the prompt", async () => {
    const cmds = new Map<string, (args: string, ctx: object) => Promise<void>>();
    const sent: { text: string; opts: unknown }[] = [];
    claudeSkills(
      { registerCommand: (n, o) => cmds.set(n, o.handler), sendUserMessage: (text, opts) => sent.push({ text, opts }) },
      { root },
    );
    expect([...cmds.keys()]).toEqual(["awslogin", "cf:plan"]);
    await cmds.get("cf:plan")?.("x", { isIdle: () => false });
    expect(sent[0]?.text).toContain("/cf:plan skill");
    expect(sent[0]?.opts).toEqual({ deliverAs: "followUp" });
  });
});
