/*
 * Subagent tool: delegate tasks to specialized agents.
 *
 * Vendored from pi (MIT License, Copyright (c) Mario Zechner):
 * packages/coding-agent/examples/extensions/subagent/index.ts, pi 0.99.1.
 *
 * Spawns a separate pi process per invocation (isolated context window), in
 * three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Porcupine adaptations: no pi imports (own minimal types, JSON-schema
 * parameters); the TUI renderCall/renderResult are dropped since the PWA
 * renders the tool details itself; child models go through porcupine's
 * routing rules (child.ts); the child env drops porcupine secrets and every
 * provider key but its own, carries the parent's cf session id, and the child
 * loads the claude-hooks and ask_user_question extensions so cf guarding
 * applies and questions get a "decide yourself" answer. The binary is
 * PORCUPINE_PI_BIN or `pi`, as for the parent session. Child assistant
 * messages stay in the tool details, where the hub's usage ledger records
 * them under the parent session.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSessionId } from "../claude-hooks/session-id.js";
import type { ModelRef } from "../../cli/routing.js";
import { type AgentConfig, type AgentScope, CONFIG_DIR_NAME, discoverAgents, getAgentDir } from "./agents.js";
import { buildSubagentArgs, buildSubagentEnv, resolveChildModel } from "./child.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

const CHILD_EXTENSIONS = [
  fileURLToPath(new URL("../claude-hooks/index.js", import.meta.url)),
  fileURLToPath(new URL("../ask-user-question.js", import.meta.url)),
];

interface Entry {
  type: string;
  customType?: string;
  data?: unknown;
}
interface Content {
  type: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
export interface Message {
  role: string;
  content: Content[] | string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } };
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
}
interface Ctx {
  cwd: string;
  hasUI?: boolean;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  ui?: { confirm(title: string, message: string): Promise<boolean> };
  sessionManager?: { getEntries(): Entry[]; getSessionId?(): string };
}
export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}
export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "builtin" | "unknown";
  task: string;
  /** -1 while running. */
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string | undefined;
  provider?: string | undefined;
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
  step?: number | undefined;
}
export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}
interface ToolResult {
  content: { type: "text"; text: string }[];
  details: SubagentDetails;
  isError?: boolean;
}
type OnUpdate = (partial: ToolResult) => void;
interface TaskItem {
  agent: string;
  task: string;
  cwd?: string;
}
interface Params {
  agent?: string;
  task?: string;
  tasks?: TaskItem[];
  chain?: TaskItem[];
  agentScope?: AgentScope;
  confirmProjectAgents?: boolean;
  cwd?: string;
}
export interface Api {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: Params, signal: AbortSignal | undefined, onUpdate: OnUpdate | undefined, ctx: Ctx): Promise<ToolResult>;
  }): void;
}

const emptyUsage = (): UsageStats => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) if (part.type === "text" && part.text) return part.text;
  }
  return "";
}

function isFailedResult(r: SingleResult): boolean {
  return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

function getResultOutput(r: SingleResult): string {
  if (isFailedResult(r)) return r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)";
  return getFinalOutput(r.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(items: TIn[], concurrency: number, fn: (item: TIn, index: number) => Promise<TOut>): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array<TOut>(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current] as TIn, current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

interface Dispatch {
  parentModel: ModelRef | undefined;
  thinkingLevel: string | undefined;
  cfSessionId: string;
}

async function runSingleAgent(
  defaultCwd: string,
  dispatch: Dispatch,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdate | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  const fail = (stderr: string, source: SingleResult["agentSource"]): SingleResult => ({
    agent: agentName,
    agentSource: source,
    task,
    exitCode: 1,
    messages: [],
    stderr,
    usage: emptyUsage(),
    step,
  });
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return fail(`Unknown agent: "${agentName}". Available agents: ${available}.`, "unknown");
  }
  const routed = resolveChildModel(agent.model, dispatch.parentModel, process.env);
  if (!routed.ok) return fail(routed.error, agent.source);
  const model = routed.model;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: model.id,
    provider: model.provider,
    step,
  };
  const emitUpdate = (): void => {
    onUpdate?.({
      content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
      details: makeDetails([currentResult]),
    });
  };

  let tmp: { dir: string; filePath: string } | null = null;
  try {
    if (agent.systemPrompt.trim()) tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
    const args = buildSubagentArgs({
      model,
      thinking: agent.model ? undefined : dispatch.thinkingLevel,
      tools: agent.tools,
      extensions: CHILD_EXTENSIONS,
      systemPromptFile: tmp?.filePath,
      task,
    });
    let wasAborted = false;
    emitUpdate();

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(process.env.PORCUPINE_PI_BIN ?? "pi", args, {
        cwd: cwd ?? defaultCwd,
        env: buildSubagentEnv(process.env, model.provider, dispatch.cfSessionId),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      const processLine = (line: string): void => {
        if (!line.trim()) return;
        let event: { type?: string; message?: Message };
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          return;
        }
        if (event.type === "message_end" && event.message) {
          const msg = event.message;
          currentResult.messages.push(msg);
          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const u = msg.usage;
            if (u) {
              currentResult.usage.input += u.input || 0;
              currentResult.usage.output += u.output || 0;
              currentResult.usage.cacheRead += u.cacheRead || 0;
              currentResult.usage.cacheWrite += u.cacheWrite || 0;
              currentResult.usage.cost += u.cost?.total || 0;
              currentResult.usage.contextTokens = u.totalTokens || 0;
            }
            if (msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }
        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message);
          emitUpdate();
        }
      };
      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data: Buffer) => {
        currentResult.stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      proc.on("error", (e) => {
        currentResult.stderr += e.message;
        resolve(1);
      });
      if (signal) {
        const killProc = (): void => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000).unref();
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });
    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmp) fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
}

const TASK_ITEM = {
  type: "object",
  required: ["agent", "task"],
  properties: {
    agent: { type: "string", description: "Name of the agent to invoke" },
    task: { type: "string", description: "Task to delegate to the agent" },
    cwd: { type: "string", description: "Working directory for the agent process" },
  },
};
const CHAIN_ITEM = {
  ...TASK_ITEM,
  properties: { ...TASK_ITEM.properties, task: { type: "string", description: "Task with optional {previous} placeholder for prior output" } },
};
const PARAMETERS = {
  type: "object",
  properties: {
    agent: { type: "string", description: "Name of the agent to invoke (for single mode)" },
    task: { type: "string", description: "Task to delegate (for single mode)" },
    tasks: { type: "array", items: TASK_ITEM, description: "Array of {agent, task} for parallel execution" },
    chain: { type: "array", items: CHAIN_ITEM, description: "Array of {agent, task} for sequential execution" },
    agentScope: {
      type: "string",
      enum: ["user", "project", "both"],
      default: "user",
      description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
    },
    confirmProjectAgents: { type: "boolean", default: true, description: "Prompt before running project-local agents. Default: true." },
    cwd: { type: "string", description: "Working directory for the agent process (single mode)" },
  },
};

export default function subagent(pi: Api): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      'The built-in "general-purpose" agent runs on your model with the default tools.',
      `Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
      `To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
    ].join(" "),
    parameters: PARAMETERS,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "user";
      const dispatch: Dispatch = {
        parentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
        thinkingLevel: ctx.thinkingLevel,
        cfSessionId: resolveSessionId(process.env, ctx.sessionManager?.getEntries() ?? [], ctx.sessionManager?.getSessionId?.() ?? null).id,
      };
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? true;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
      const makeDetails =
        (mode: SubagentDetails["mode"]) =>
        (results: SingleResult[]): SubagentDetails => ({ mode, agentScope, projectAgentsDir: discovery.projectAgentsDir, results });

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }],
          details: makeDetails("single")([]),
        };
      }

      if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI && ctx.ui) {
        const requested = new Set<string>();
        for (const s of params.chain ?? []) requested.add(s.agent);
        for (const t of params.tasks ?? []) requested.add(t.agent);
        if (params.agent) requested.add(params.agent);
        const projectAgents = [...requested].map((n) => agents.find((a) => a.name === n)).filter((a): a is AgentConfig => a?.source === "project");
        if (projectAgents.length > 0) {
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            `Agents: ${projectAgents.map((a) => a.name).join(", ")}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok) {
            return {
              content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
              details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
            };
          }
        }
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";
        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i] as TaskItem;
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const chainUpdate: OnUpdate | undefined = onUpdate
            ? (partial) => {
                const current = partial.details.results[0];
                if (current) onUpdate({ content: partial.content, details: makeDetails("chain")([...results, current]) });
              }
            : undefined;
          const result = await runSingleAgent(ctx.cwd, dispatch, agents, step.agent, taskWithContext, step.cwd, i + 1, signal, chainUpdate, makeDetails("chain"));
          results.push(result);
          if (isFailedResult(result)) {
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` }],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [{ type: "text", text: getFinalOutput(results[results.length - 1]?.messages ?? []) || "(no output)" }],
          details: makeDetails("chain")(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
            details: makeDetails("parallel")([]),
          };
        }
        const allResults: SingleResult[] = params.tasks.map((t) => ({
          agent: t.agent,
          agentSource: "unknown",
          task: t.task,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: emptyUsage(),
        }));
        const emitParallelUpdate = (): void => {
          if (!onUpdate) return;
          const running = allResults.filter((r) => r.exitCode === -1).length;
          onUpdate({
            content: [{ type: "text", text: `Parallel: ${allResults.length - running}/${allResults.length} done, ${running} running...` }],
            details: makeDetails("parallel")([...allResults]),
          });
        };
        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
          const result = await runSingleAgent(ctx.cwd, dispatch, agents, t.agent, t.task, t.cwd, undefined, signal, (partial) => {
            const r = partial.details.results[0];
            if (r) {
              allResults[index] = r;
              emitParallelUpdate();
            }
          }, makeDetails("parallel"));
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });
        const successCount = results.filter((r) => !isFailedResult(r)).length;
        const summaries = results.map((r) => {
          const status = isFailedResult(r) ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}` : "completed";
          return `### [${r.agent}] ${status}\n\n${truncateParallelOutput(getResultOutput(r))}`;
        });
        return {
          content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
          details: makeDetails("parallel")(results),
        };
      }

      const { agent = "", task = "" } = params;
      const result = await runSingleAgent(ctx.cwd, dispatch, agents, agent, task, params.cwd, undefined, signal, onUpdate, makeDetails("single"));
      if (isFailedResult(result)) {
        return {
          content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
          details: makeDetails("single")([result]),
          isError: true,
        };
      }
      return { content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }], details: makeDetails("single")([result]) };
    },
  });
}
