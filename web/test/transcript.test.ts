// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { applyEvent, emptyTranscript, fromMessages } from "../src/transcript.js";

const user = { role: "user", content: "hi", timestamp: 1 };
const assistantFinal = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "let me think" },
    { type: "text", text: "Hello there" },
    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
  ],
  stopReason: "toolUse",
  timestamp: 2,
};

const script: Record<string, unknown>[] = [
  { type: "agent_start" },
  { type: "message_start", message: user },
  { type: "message_end", message: user },
  { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 2 } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "let me " } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "think" } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" } },
  { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "call_1", toolName: "bash" } },
  { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"command":' } },
  { type: "message_end", message: assistantFinal },
  { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
  {
    type: "tool_execution_update",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "ls" },
    partialResult: { content: [{ type: "text", text: "partial" }] },
  },
  {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "a.txt\nb.txt" }] },
    isError: false,
  },
];

describe("event reducer", () => {
  it("builds a transcript from deltas, thinking and tool events", () => {
    const t = emptyTranscript();
    for (const ev of script.slice(0, 9)) applyEvent(t, ev);
    expect(t.isStreaming).toBe(true);
    const streaming = t.items[1];
    expect(streaming?.kind).toBe("assistant");
    if (streaming?.kind !== "assistant") throw new Error();
    expect(streaming.blocks).toEqual([
      { type: "thinking", text: "let me think" },
      { type: "text", text: "Hello" },
    ]);
    for (const ev of script.slice(9)) applyEvent(t, ev);
    applyEvent(t, { type: "agent_settled" });
    expect(t.isStreaming).toBe(false);
    expect(t.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    const a = t.items[1];
    if (a?.kind !== "assistant") throw new Error();
    expect(a.blocks[1]).toEqual({ type: "text", text: "Hello there" });
    expect(a.blocks[2]).toEqual({ type: "toolCall", id: "call_1" });
    const tool = t.tools.get("call_1");
    expect(tool?.status).toBe("done");
    expect(tool?.output).toBe("a.txt\nb.txt");
    expect(tool?.argsText).toContain('"command": "ls"');
  });

  it("creates a message lazily when updates arrive after a gap", () => {
    const t = emptyTranscript();
    applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "…tail" } });
    expect(t.items).toHaveLength(1);
    applyEvent(t, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "full text" }], timestamp: 9 } });
    const a = t.items[0];
    if (a?.kind !== "assistant") throw new Error();
    expect(a.blocks).toEqual([{ type: "text", text: "full text" }]);
  });

  it("shows model errors and notices inline", () => {
    const t = emptyTranscript();
    applyEvent(t, {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "403 customer_verification_required", timestamp: 3 },
    });
    applyEvent(t, { type: "porcupine_notice", level: "warn", text: "extension UI select auto-cancelled: pick" });
    applyEvent(t, { type: "extension_error", event: "tool_call", error: "boom" });
    const a = t.items[0];
    if (a?.kind !== "assistant") throw new Error();
    expect(a.error).toContain("customer_verification_required");
    expect(t.items.slice(1).map((i) => i.kind)).toEqual(["notice", "notice"]);
  });

  it("reset path: rebuilds from get_messages and does not duplicate replayed messages", () => {
    const toolResult = { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 3 };
    const t = fromMessages([user, assistantFinal, toolResult]);
    expect(t.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(t.tools.get("call_1")?.status).toBe("done");
    // The CLI replays its buffer after a reset; those messages are already present.
    for (const ev of script) applyEvent(t, ev);
    expect(t.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(t.tools.get("call_1")?.output).toBe("a.txt\nb.txt");
    // A new live message after the replay still appends.
    applyEvent(t, { type: "message_start", message: { role: "user", content: "next", timestamp: 10 } });
    expect(t.items).toHaveLength(3);
  });
});
