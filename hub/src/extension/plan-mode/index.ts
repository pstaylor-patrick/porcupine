/*
 * Plan Mode Extension: read-only exploration mode for safe code analysis.
 *
 * Vendored from pi (MIT License, Copyright (c) Mario Zechner):
 * packages/coding-agent/examples/extensions/plan-mode/index.ts, pi 0.99.1.
 *
 * - /plan toggles plan mode; built-in write tools are disabled while it is on
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers complete steps during execution
 * - Progress via setStatus/setWidget, which porcupine forwards to the PWA panel
 *
 * Porcupine adaptations: no pi imports (own minimal types); the Ctrl+Alt+P
 * shortcut and the --plan flag are dropped (no TUI); theme colouring is
 * replaced by plain text, since the PWA renders status and widgets as text;
 * the plan-mode prompt names ask_user_question instead of questionnaire; the
 * /todos command is renamed /plan-todos so it does not clash with the todo
 * extension.
 */
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "ask_user_question"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

export const PLAN_ENTRY = "plan-mode";
export const PLAN_STATUS_KEY = "plan-mode";
export const PLAN_WIDGET_KEY = "plan-todos";

interface PlanModeState {
  enabled: boolean;
  todos?: TodoItem[];
  executing?: boolean;
  toolsBeforePlanMode?: string[];
}

interface TextBlock {
  type: string;
  text?: string;
}
interface Message {
  role?: string;
  content?: unknown;
  customType?: string;
}
interface Entry {
  type: string;
  customType?: string;
  data?: unknown;
  message?: Message;
}
export interface Ctx {
  hasUI?: boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget(key: string, lines: string[] | undefined): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
  };
  sessionManager: { getEntries(): Entry[] };
}
interface CustomMessage {
  customType: string;
  content: string;
  display: boolean;
}
export interface Api {
  on(event: "tool_call", handler: (event: { toolName: string; input: Record<string, unknown> }) => Promise<{ block: true; reason: string } | undefined>): unknown;
  on(event: "context", handler: (event: { messages: Message[] }) => Promise<{ messages: Message[] } | undefined>): unknown;
  on(event: "before_agent_start", handler: () => Promise<{ message: CustomMessage } | undefined>): unknown;
  on(event: "turn_end", handler: (event: { message: Message }, ctx: Ctx) => Promise<void>): unknown;
  on(event: "agent_end", handler: (event: { messages: Message[] }, ctx: Ctx) => Promise<void>): unknown;
  on(event: "session_start", handler: (event: unknown, ctx: Ctx) => Promise<void>): unknown;
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
  appendEntry(customType: string, data?: unknown): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  sendMessage(message: CustomMessage, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" }): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

function isAssistantMessage(m: Message | undefined): m is Message & { content: TextBlock[] } {
  return m?.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: Message & { content: TextBlock[] }): string {
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Plain-text status line and widget lines for the PWA panel. */
export function planView(s: { planModeEnabled: boolean; executionMode: boolean; todoItems: TodoItem[] }): {
  status: string | undefined;
  widget: string[] | undefined;
} {
  const executing = s.executionMode && s.todoItems.length > 0;
  const completed = s.todoItems.filter((t) => t.completed).length;
  return {
    status: executing ? `plan ${completed}/${s.todoItems.length}` : s.planModeEnabled ? "plan mode" : undefined,
    widget: executing ? s.todoItems.map((item) => `${item.completed ? "[x]" : "[ ]"} ${item.text}`) : undefined,
  };
}

export default function planModeExtension(pi: Api): void {
  let planModeEnabled = false;
  let executionMode = false;
  let todoItems: TodoItem[] = [];
  let toolsBeforePlanMode: string[] | undefined;

  function updateStatus(ctx: Ctx): void {
    const v = planView({ planModeEnabled, executionMode, todoItems });
    ctx.ui.setStatus(PLAN_STATUS_KEY, v.status);
    ctx.ui.setWidget(PLAN_WIDGET_KEY, v.widget);
  }

  const uniqueToolNames = (toolNames: string[]): string[] => [...new Set(toolNames)];
  const getPlanModeTools = (active: string[]): string[] =>
    uniqueToolNames([...active.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)), ...PLAN_MODE_TOOLS]);
  const getNormalModeTools = (active: string[]): string[] =>
    uniqueToolNames([...NORMAL_MODE_TOOLS, ...active.filter((name) => !PLAN_MANAGED_TOOLS.has(name))]);

  function enablePlanModeTools(): void {
    if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
    pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
  }

  function restoreNormalModeTools(): void {
    pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
    toolsBeforePlanMode = undefined;
  }

  function persistState(): void {
    pi.appendEntry(PLAN_ENTRY, { enabled: planModeEnabled, todos: todoItems, executing: executionMode, toolsBeforePlanMode });
  }

  function togglePlanMode(ctx: Ctx): void {
    planModeEnabled = !planModeEnabled;
    executionMode = false;
    todoItems = [];
    if (planModeEnabled) {
      enablePlanModeTools();
      ctx.ui.notify("Plan mode enabled. Built-in write tools disabled.");
    } else {
      restoreNormalModeTools();
      ctx.ui.notify("Plan mode disabled. Full access restored.");
    }
    updateStatus(ctx);
    persistState();
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only exploration)",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("plan-todos", {
    description: "Show current plan todo list",
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify("No todos. Create a plan first with /plan", "info");
        return;
      }
      const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "done" : "open"} ${item.text}`).join("\n");
      ctx.ui.notify(`Plan Progress:\n${list}`, "info");
    },
  });

  // Block destructive bash commands in plan mode.
  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "bash") return undefined;
    const command = String(event.input.command ?? "");
    if (isSafeCommand(command)) return undefined;
    return {
      block: true,
      reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
    };
  });

  // Filter out stale plan mode context when not in plan mode.
  pi.on("context", async (event) => {
    if (planModeEnabled) return undefined;
    return {
      messages: event.messages.filter((m) => {
        if (m.customType === "plan-mode-context") return false;
        if (m.role !== "user") return true;
        const content = m.content;
        if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
        if (Array.isArray(content)) {
          return !(content as TextBlock[]).some((c) => c.type === "text" && c.text?.includes("[PLAN MODE ACTIVE]"));
        }
        return true;
      }),
    };
  });

  // Inject plan/execution context before the agent starts.
  pi.on("before_agent_start", async () => {
    if (planModeEnabled) {
      return {
        message: {
          customType: "plan-mode-context",
          content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the ask_user_question tool.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
          display: false,
        },
      };
    }
    if (executionMode && todoItems.length > 0) {
      const todoList = todoItems
        .filter((t) => !t.completed)
        .map((t) => `${t.step}. ${t.text}`)
        .join("\n");
      return {
        message: {
          customType: "plan-execution-context",
          content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
          display: false,
        },
      };
    }
    return undefined;
  });

  // Track progress after each turn.
  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;
    if (markCompletedSteps(getTextContent(event.message), todoItems) > 0) updateStatus(ctx);
    persistState();
  });

  // Handle plan completion and the plan mode prompt.
  pi.on("agent_end", async (event, ctx) => {
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed)) {
        const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
        pi.sendMessage({ customType: "plan-complete", content: `**Plan Complete!**\n\n${completedList}`, display: true }, { triggerTurn: false });
        executionMode = false;
        todoItems = [];
        updateStatus(ctx);
        persistState();
      }
      return;
    }
    if (!planModeEnabled || !ctx.hasUI) return;

    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const extracted = extractTodoItems(getTextContent(lastAssistant));
      if (extracted.length > 0) todoItems = extracted;
    }
    if (todoItems.length === 0) return;
    persistState();

    const todoListText = todoItems.map((t, i) => `${i + 1}. ${t.text}`).join("\n");
    const planTodoListMessage = {
      customType: "plan-todo-list",
      content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
      display: true,
    };

    const choice = await ctx.ui.select("Plan mode - what next?", ["Execute the plan (track progress)", "Stay in plan mode", "Refine the plan"]);
    if (choice?.startsWith("Execute")) {
      const firstTodoItem = todoItems[0];
      if (!firstTodoItem) return;
      planModeEnabled = false;
      executionMode = true;
      restoreNormalModeTools();
      updateStatus(ctx);
      persistState();
      const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
      const execMessage = `Execute the plan.

Remaining steps:
${remainingList}

Start with: ${firstTodoItem.text}
After completing a step, include a [DONE:n] tag in your response.`;
      pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
      pi.sendMessage({ customType: "plan-mode-execute", content: execMessage, display: true }, { triggerTurn: true, deliverAs: "followUp" });
    } else if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
        pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
      }
    }
  });

  // Restore state on session start/resume.
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const planModeEntry = entries.filter((e) => e.type === "custom" && e.customType === PLAN_ENTRY).pop();
    const data = planModeEntry?.data as PlanModeState | undefined;
    if (data) {
      planModeEnabled = data.enabled ?? planModeEnabled;
      todoItems = data.todos ?? todoItems;
      executionMode = data.executing ?? executionMode;
      toolsBeforePlanMode = data.toolsBeforePlanMode ?? toolsBeforePlanMode;
    }

    // On resume, re-scan messages after the last plan-mode-execute to rebuild completion state.
    if (planModeEntry !== undefined && executionMode && todoItems.length > 0) {
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.customType === "plan-mode-execute") {
          executeIndex = i;
          break;
        }
      }
      const texts: string[] = [];
      for (const entry of entries.slice(executeIndex + 1)) {
        if (entry.type === "message" && isAssistantMessage(entry.message)) texts.push(getTextContent(entry.message));
      }
      markCompletedSteps(texts.join("\n"), todoItems);
    }

    if (planModeEnabled) enablePlanModeTools();
    updateStatus(ctx);
  });
}
