/** Discovers ~/.claude/skills/<name>/SKILL.md and builds the prompt a skill command sends. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  /** Command name: the directory name, so cf:plan stays /cf:plan. */
  name: string;
  description: string;
  dir: string;
  file: string;
}

/** Splits leading YAML frontmatter off; returns its description (single-line value) and the body. */
export function splitFrontmatter(text: string): { description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { description: "", body: text };
  const fm = m[1] ?? "";
  const d = /^description:[ \t]*(.*)$/m.exec(fm);
  let description = (d?.[1] ?? "").trim();
  if ((description.startsWith('"') && description.endsWith('"')) || (description.startsWith("'") && description.endsWith("'"))) {
    description = description.slice(1, -1);
  }
  return { description, body: text.slice(m[0].length).replace(/^\s+/, "") };
}

const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

export function discoverSkills(root: string): Skill[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const name of names.sort()) {
    if (!VALID_NAME.test(name)) continue;
    const dir = join(root, name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    out.push({ name, description: splitFrontmatter(text).description || `Skill ${name}`, dir, file });
  }
  return out;
}

export interface ToolAvailability {
  subagent: boolean;
}

/** Notes how Claude-Code-only tools named in a skill map onto porcupine. */
export function toolNote(avail: ToolAvailability): string {
  return [
    "Tool mapping for this skill (it was written for Claude Code):",
    "- AskUserQuestion: use the ask_user_question tool.",
    avail.subagent
      ? "- Agent / Task (subagents): use the subagent tool."
      : "- Agent / Task (subagents): not available in porcupine yet; do that work yourself in this session and say so.",
    "- Workflow: not supported in porcupine. Tell the user plainly and do the steps directly instead.",
  ].join("\n");
}

export function skillPrompt(skill: Skill, args: string, avail: ToolAvailability): string {
  const { body } = splitFrontmatter(readFileSync(skill.file, "utf8"));
  const parts = [
    `<skill name="${skill.name}" dir="${skill.dir}">`,
    `This is the /${skill.name} skill. Its directory is ${skill.dir}; resolve relative paths it mentions (such as reference/ files) from there and read them from disk when needed.`,
    toolNote(avail),
    "",
    body.trimEnd(),
    "</skill>",
  ];
  if (args.trim()) parts.push("", `Arguments: ${args.trim()}`);
  return parts.join("\n");
}
