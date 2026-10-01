import { describe, expect, it } from "vitest";
import planMode, { planView, type Api as PlanApi, type Ctx as PlanCtx } from "../src/extension/plan-mode/index.js";
import { extractTodoItems, isSafeCommand, markCompletedSteps } from "../src/extension/plan-mode/utils.js";
import todo, { formatTodos, todoWidget, type Api as TodoApi, type Ctx as TodoCtx } from "../src/extension/todo/index.js";

describe("plan-mode utils", () => {
  it("allows read-only commands and blocks writes", () => {
    expect(isSafeCommand("git status")).toBe(true);
    expect(isSafeCommand("rm -rf x")).toBe(false);
    expect(isSafeCommand("cat a > b")).toBe(false);
  });
  it("extracts plan steps and marks done", () => {
    const items = extractTodoItems("Plan:\n1. Read the config file\n2. Update the parser logic\n");
    expect(items.map((i) => i.text)).toEqual(["Config file", "Parser logic"]);
    expect(markCompletedSteps("did it [DONE:1]", items)).toBe(1);
    expect(planView({ planModeEnabled: false, executionMode: true, todoItems: items })).toEqual({
      status: "plan 1/2",
      widget: ["[x] Config file", "[ ] Parser logic"],
    });
  });
});

describe("plan-mode extension", () => {
  it("toggles tools and blocks unsafe bash", async () => {
    const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>();
    const commands = new Map<string, (args: string, ctx: PlanCtx) => Promise<void>>();
    let active = ["read", "bash", "edit", "write", "todo"];
    const status: (string | undefined)[] = [];
    const api = {
      on: (e: string, h: (...a: unknown[]) => Promise<unknown>) => handlers.set(e, h),
      registerCommand: (n: string, o: { handler: (args: string, ctx: PlanCtx) => Promise<void> }) => commands.set(n, o.handler),
      appendEntry: () => undefined,
      getActiveTools: () => active,
      setActiveTools: (n: string[]) => (active = n),
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
    } as unknown as PlanApi;
    planMode(api);
    const ctx: PlanCtx = {
      ui: { notify: () => undefined, setStatus: (_k, t) => status.push(t), setWidget: () => undefined, select: async () => undefined, editor: async () => undefined },
      sessionManager: { getEntries: () => [] },
    };
    await commands.get("plan")?.("", ctx);
    expect(active).not.toContain("edit");
    expect(active).toContain("todo");
    expect(status.at(-1)).toBe("plan mode");
    const blocked = await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "rm x" } });
    expect(blocked).toMatchObject({ block: true });
    await commands.get("plan")?.("", ctx);
    expect(active).toEqual(["read", "bash", "edit", "write", "todo"]);
  });
});

describe("todo extension", () => {
  it("adds, toggles and shows a widget, rebuilding from the branch", async () => {
    let tool: { execute: (...a: unknown[]) => Promise<{ details: { todos: unknown[] } }> } | undefined;
    const handlers = new Map<string, (e: unknown, ctx: TodoCtx) => Promise<void>>();
    const widgets: (string[] | undefined)[] = [];
    const api = {
      on: (e: string, h: (e: unknown, ctx: TodoCtx) => Promise<void>) => handlers.set(e, h),
      registerCommand: () => undefined,
      registerTool: (t: typeof tool) => (tool = t),
    } as unknown as TodoApi;
    todo(api);
    const ctx: TodoCtx = { ui: { notify: () => undefined, setWidget: (_k, l) => widgets.push(l) }, sessionManager: { getEntries: () => [] } };
    await tool?.execute("1", { action: "add", text: "write tests" }, undefined, undefined, ctx);
    const r = await tool?.execute("2", { action: "toggle", id: 1 }, undefined, undefined, ctx);
    expect(widgets[0]).toEqual(["[ ] write tests"]);
    expect(widgets[1]).toBeUndefined();
    expect(formatTodos([{ id: 1, text: "a", done: true }])).toBe("[x] #1: a");
    expect(todoWidget([])).toBeUndefined();
    const entries = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { action: "add", todos: [{ id: 3, text: "b", done: false }], nextId: 4 } } }];
    await handlers.get("session_start")?.({}, { ...ctx, sessionManager: { getEntries: () => entries } });
    expect(widgets.at(-1)).toEqual(["[ ] b"]);
    expect(r?.details.todos).toEqual([{ id: 1, text: "write tests", done: true }]);
  });
});
