/*
 * Agent discovery and configuration.
 *
 * Vendored from pi (MIT License, Copyright (c) Mario Zechner):
 * packages/coding-agent/examples/extensions/subagent/agents.ts, pi 0.99.1.
 * Adapted for porcupine: no pi imports (a small frontmatter reader replaces
 * parseFrontmatter), agent dir resolved from PI_CODING_AGENT_DIR or
 * ~/.pi/agent, and a built-in "general-purpose" agent when none by that name
 * is defined, so Claude Code's Agent tool maps onto something by default.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[] | undefined;
  model?: string | undefined;
  systemPrompt: string;
  source: "user" | "project" | "builtin";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

export const CONFIG_DIR_NAME = ".pi";

export const BUILTIN_AGENT: AgentConfig = {
  name: "general-purpose",
  description: "General-purpose agent on the parent's model with the default tools.",
  systemPrompt: "",
  source: "builtin",
  filePath: "(builtin)",
};

export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR?.trim() || path.join(env.HOME ?? os.homedir(), ".pi", "agent");
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

/** Flat `key: value` frontmatter; enough for agent files (name, description, tools, model). */
export function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (kv) frontmatter[kv[1] as string] = unquote(kv[2] ?? "");
  }
  return { frontmatter, body: text.slice(m[0].length) };
}

/** `tools: read, bash` or `tools: [read, bash]`. */
export function parseToolList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const raw = value.replace(/^\[|\]$/g, "").split(",");
  const tools = raw.map((t) => unquote(t)).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter.name || !frontmatter.description) continue;
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: frontmatter.model || undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function discoverAgents(cwd: string, scope: AgentScope, agentDir: string = getAgentDir()): AgentDiscoveryResult {
  const userDir = path.join(agentDir, "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>([[BUILTIN_AGENT.name, BUILTIN_AGENT]]);
  if (scope !== "project") for (const agent of userAgents) agentMap.set(agent.name, agent);
  if (scope !== "user") for (const agent of projectAgents) agentMap.set(agent.name, agent);
  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
