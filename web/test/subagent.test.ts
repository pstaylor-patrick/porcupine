// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderTool } from "../src/render.js";
import { childViews } from "../src/subagent.js";
import { applyEvent, emptyTranscript } from "../src/transcript.js";

const EVIL = '<img src=x onerror="window.__pwned=1">';

/** Recorded shape of a parallel subagent tool_execution_update. */
const UPDATE = {
  type: "tool_execution_update",
  toolCallId: "call-1",
  toolName: "subagent",
  args: { tasks: [{ agent: "scout", task: "look" }, { agent: "general-purpose", task: "fix" }] },
  partialResult: {
    content: [{ type: "text", text: "Parallel: 1/2 done, 1 running..." }],
    details: {
      mode: "parallel",
      agentScope: "user",
      projectAgentsDir: null,
      results: [
        {
          agent: "scout",
          task: "look",
          exitCode: 0,
          provider: "openrouter",
          model: "google/gemini-3-pro",
          stderr: "",
          messages: [
            { role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "text", text: `found it ${EVIL}` }] },
          ],
          usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.0123, contextTokens: 0, turns: 1 },
        },
        { agent: "general-purpose", task: "fix", exitCode: -1, messages: [], stderr: "", usage: { turns: 0 } },
      ],
    },
  },
};

describe("subagent rendering", () => {
  it("builds one view per child", () => {
    const v = childViews(UPDATE.partialResult.details);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ agent: "scout", status: "done", model: "openrouter/google/gemini-3-pro" });
    expect(v[0]?.tail).toBe(`→ read\nfound it ${EVIL}`);
    expect(v[0]?.usage).toBe("1 turn ↑1.2k ↓300 $0.0123");
    expect(v[1]?.status).toBe("running");
    expect(childViews(undefined)).toEqual([]);
  });

  it("renders children as collapsible details blocks, text only", () => {
    const t = emptyTranscript();
    applyEvent(t, { type: "tool_execution_start", toolCallId: "call-1", toolName: "subagent", args: UPDATE.args });
    applyEvent(t, UPDATE);
    const s = t.tools.get("call-1");
    if (!s) throw new Error("no tool state");
    const open = new Set<string>();
    const card = renderTool(s, open);
    const kids = card.querySelectorAll("details.subagent");
    expect(kids).toHaveLength(2);
    expect(kids[0]?.classList.contains("subagent-done")).toBe(true);
    expect(kids[1]?.classList.contains("subagent-running")).toBe(true);
    expect(kids[0]?.querySelector(".subagent-name")?.textContent).toBe("scout");
    expect(kids[0]?.querySelector(".subagent-tail")?.textContent).toContain(EVIL);
    expect(card.querySelector("img")).toBeNull();
    (kids[0] as HTMLDetailsElement).open = true;
    kids[0]?.dispatchEvent(new Event("toggle"));
    expect(open.has("subagent:call-1:0")).toBe(true);
  });
});
