/*
 * Todo extension: a `todo` tool the model uses to keep a todo list, and a
 * /todos command that shows it.
 *
 * Vendored from pi (MIT License, Copyright (c) Mario Zechner):
 * packages/coding-agent/examples/extensions/todo.ts, pi 0.99.1.
 *
 * State lives in the tool result details (not external files), so branching
 * and forking keep the right list for that point in history.
 *
 * Porcupine adaptations: no pi imports (own minimal types, JSON-schema
 * parameters); the TUI list component and renderCall/renderResult are
 * dropped; /todos notifies the list as text instead; the open list is shown
 * through setWidget, which porcupine forwards to the PWA status panel.
 */

export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

export interface TodoDetails {
  action: "list" | "add" | "toggle" | "clear";
  todos: Todo[];
  nextId: number;
  error?: string;
}

export const TODO_WIDGET_KEY = "todos";

interface Entry {
  type: string;
  message?: { role?: string; toolName?: string; details?: unknown };
}
export interface Ctx {
  ui?: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setWidget?(key: string, lines: string[] | undefined): void;
  };
  sessionManager?: { getBranch?(): Entry[]; getEntries(): Entry[] };
}
interface ToolResult {
  content: { type: "text"; text: string }[];
  details: TodoDetails;
}
export interface Api {
  on(event: "session_start" | "session_tree", handler: (event: unknown, ctx: Ctx) => Promise<void>): unknown;
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: Ctx): Promise<ToolResult>;
  }): void;
}

export function formatTodos(todos: Todo[]): string {
  return todos.length ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n") : "No todos";
}

/** Widget lines: shown while any todo is open, hidden otherwise. */
export function todoWidget(todos: Todo[]): string[] | undefined {
  if (!todos.some((t) => !t.done)) return undefined;
  return todos.map((t) => `${t.done ? "[x]" : "[ ]"} ${t.text}`);
}

export default function todoExtension(pi: Api): void {
  let todos: Todo[] = [];
  let nextId = 1;

  const showWidget = (ctx: Ctx | undefined): void => ctx?.ui?.setWidget?.(TODO_WIDGET_KEY, todoWidget(todos));

  /** Rebuilds state from the todo tool results on the current branch. */
  const reconstructState = async (_event: unknown, ctx: Ctx): Promise<void> => {
    todos = [];
    nextId = 1;
    const sm = ctx.sessionManager;
    const entries = sm?.getBranch ? sm.getBranch() : (sm?.getEntries() ?? []);
    for (const entry of entries) {
      const msg = entry.message;
      if (entry.type !== "message" || msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
      const details = msg.details as TodoDetails | undefined;
      if (details && Array.isArray(details.todos)) {
        todos = details.todos;
        nextId = details.nextId;
      }
    }
    showWidget(ctx);
  };

  pi.on("session_start", reconstructState);
  pi.on("session_tree", reconstructState);

  const result = (text: string, action: TodoDetails["action"], error?: string): ToolResult => ({
    content: [{ type: "text", text }],
    details: error ? { action, todos: [...todos], nextId, error } : { action, todos: [...todos], nextId },
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
    parameters: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "add", "toggle", "clear"] },
        text: { type: "string", description: "Todo text (for add)" },
        id: { type: "number", description: "Todo ID (for toggle)" },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const action = params["action"];
      try {
        switch (action) {
          case "list":
            return result(formatTodos(todos), "list");
          case "add": {
            const text = params["text"];
            if (typeof text !== "string" || !text) return result("Error: text required for add", "add", "text required");
            const todo: Todo = { id: nextId++, text, done: false };
            todos.push(todo);
            return result(`Added todo #${todo.id}: ${todo.text}`, "add");
          }
          case "toggle": {
            const id = params["id"];
            if (typeof id !== "number") return result("Error: id required for toggle", "toggle", "id required");
            const todo = todos.find((t) => t.id === id);
            if (!todo) return result(`Todo #${id} not found`, "toggle", `#${id} not found`);
            todo.done = !todo.done;
            return result(`Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}`, "toggle");
          }
          case "clear": {
            const count = todos.length;
            todos = [];
            nextId = 1;
            return result(`Cleared ${count} todos`, "clear");
          }
          default:
            return result(`Unknown action: ${String(action)}`, "list", `unknown action: ${String(action)}`);
        }
      } finally {
        showWidget(ctx);
      }
    },
  });

  pi.registerCommand("todos", {
    description: "Show all todos on the current branch",
    handler: async (_args, ctx) => {
      ctx.ui?.notify(formatTodos(todos), "info");
    },
  });
}
