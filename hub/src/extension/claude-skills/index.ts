/**
 * Pi extension: exposes ~/.claude/skills/<name>/SKILL.md (cf:* and user
 * skills) as /<name> commands. Each command sends the skill body, frontmatter
 * stripped, as a user message with a note on its directory and on how
 * Claude-Code-only tools map here. Pi's own skills loader is not used: it
 * would rename cf:plan and does not add the tool notes.
 *
 * Carries its own minimal types; pi resolves nothing from this file.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverSkills, skillPrompt, type ToolAvailability } from "./skills.js";

interface Ctx {
  isIdle?(): boolean;
  hasUI?: boolean;
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}
export interface Api {
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

export interface SkillsOptions {
  root?: string;
  avail?: ToolAvailability;
}

export default function claudeSkills(pi: Api, opts: SkillsOptions = {}): void {
  const root = opts.root ?? join(process.env.HOME ?? homedir(), ".claude", "skills");
  const avail = opts.avail ?? { subagent: true };
  for (const skill of discoverSkills(root)) {
    pi.registerCommand(skill.name, {
      description: skill.description.length > 200 ? `${skill.description.slice(0, 197)}...` : skill.description,
      handler: async (args, ctx) => {
        let text: string;
        try {
          text = skillPrompt(skill, args, avail);
        } catch (e) {
          ctx.ui?.notify(`skill ${skill.name} unreadable: ${(e instanceof Error ? e.message : String(e))}`, "error");
          return;
        }
        const idle = ctx.isIdle?.() ?? true;
        pi.sendUserMessage(text, idle ? undefined : { deliverAs: "followUp" });
        await Promise.resolve();
      },
    });
  }
}
