import { describe, expect, it } from "vitest";
import askUserQuestion, {
  ASK_TITLE_PREFIX,
  encodeAskTitle,
  formatResult,
  parseAnswers,
  type AskQuestion,
} from "../src/extension/ask-user-question.js";
import { handleUiRequest } from "../src/cli/ui-autocancel.js";

const questions: AskQuestion[] = [
  { question: "Which order?", header: "Order", options: [{ label: "Markdown first" }, { label: "Sheet first" }] },
  { question: "Which parts?", header: "Parts", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
];

type Tool = Parameters<Parameters<typeof askUserQuestion>[0]["registerTool"]>[0];
function register(): Tool {
  let tool: Tool | undefined;
  askUserQuestion({ registerTool: (t) => (tool = t) });
  if (!tool) throw new Error("not registered");
  return tool;
}

describe("ask_user_question", () => {
  it("round-trips the question set through the input dialog title", async () => {
    const tool = register();
    let title = "";
    const ctx = {
      mode: "rpc",
      ui: {
        select: () => Promise.resolve(undefined),
        input: (t: string) => {
          title = t;
          return Promise.resolve(JSON.stringify({ answers: { "Which order?": "Sheet first", "Which parts?": "A, B", Unasked: "x" } }));
        },
      },
    };
    const res = await tool.execute("c", { questions }, undefined, undefined, ctx);
    expect(title.startsWith(ASK_TITLE_PREFIX)).toBe(true);
    expect(JSON.parse(title.slice(ASK_TITLE_PREFIX.length))).toEqual({ questions });
    expect(res.details.answers).toEqual({ "Which order?": "Sheet first", "Which parts?": "A, B" });
    expect(res.content[0]?.text).toContain("- Which order? -> Sheet first");
  });

  it("reports a dismissal and ignores malformed replies", () => {
    expect(formatResult(questions, null).content[0]?.text).toContain("dismissed");
    expect(parseAnswers("not json", questions)).toBeNull();
    expect(parseAnswers('{"answers":{"Which order?":5}}', questions)).toEqual({});
  });

  it("asks one select per question outside RPC, with a typed Other", async () => {
    const tool = register();
    const picks = ["Markdown first", "Other (type an answer)"];
    const ctx = {
      mode: "tui",
      ui: { select: () => Promise.resolve(picks.shift()), input: () => Promise.resolve("Both") },
    };
    const res = await tool.execute("c", { questions }, undefined, undefined, ctx);
    expect(res.details.answers).toEqual({ "Which order?": "Markdown first", "Which parts?": "Both" });
  });

  it("always forwards its dialog, even with no browser attached", () => {
    const d = handleUiRequest({ type: "extension_ui_request", id: "q", method: "input", title: encodeAskTitle({ questions }) });
    expect(d.forward).toBe("q");
    expect(d.response).toBeUndefined();
  });
});
