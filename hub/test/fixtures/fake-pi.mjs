#!/usr/bin/env node
/* global process, setImmediate */
// Scripted stand-in for `pi --mode rpc`. Reads JSONL commands on stdin.
// Env: FAKE_PI_ARGS_FILE / FAKE_PI_ENV_FILE dump argv and env for assertions.
import { writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  process.stdout.write("0.99.1\n");
  process.exit(0);
}
if (process.env.FAKE_PI_ARGS_FILE) writeFileSync(process.env.FAKE_PI_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_PI_ENV_FILE) writeFileSync(process.env.FAKE_PI_ENV_FILE, JSON.stringify(process.env));

const out = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const respond = (cmd, data, extra = {}) => out({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data === undefined ? {} : { data }), ...extra });
let messages = [];
let streaming = false;
let uiSeq = 0;
const waiting = new Map();

function runPrompt(text) {
  streaming = true;
  out({ type: "agent_start" });
  const msg = { role: "assistant", content: [{ type: "text", text: "" }] };
  out({ type: "message_start", message: msg });
  const parts = ["Hel", "lo ", "wor", "ld"];
  for (const p of parts) {
    msg.content[0].text += p;
    out({ type: "message_update", message: msg, assistantMessageEvent: { type: "text_delta", delta: p } });
  }
  out({ type: "message_end", message: msg });
  messages.push({ role: "user", content: text }, msg);
  out({ type: "agent_end", messages: [msg] });
  streaming = false;
  out({ type: "agent_settled" });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(cmd) {
  switch (cmd.type) {
    case "get_state":
      return respond(cmd, {
        model: { id: "anthropic/claude-sonnet-5.5", provider: "vercel-ai-gateway" },
        thinkingLevel: "medium",
        isStreaming: streaming,
        messageCount: messages.length,
      });
    case "get_messages":
      return respond(cmd, { messages });
    case "abort":
      return respond(cmd);
    case "extension_ui_response": {
      const p = waiting.get(cmd.id);
      if (p) {
        waiting.delete(cmd.id);
        out({ type: "fake_ui_answer", response: cmd, prompt: p });
        respond(p, { disposition: "started" });
        runPrompt(p.message);
      }
      return;
    }
    case "prompt":
      if (cmd.message === "__ui__") {
        const id = `ui-${++uiSeq}`;
        waiting.set(id, cmd);
        out({ type: "extension_ui_request", id, method: "confirm", title: "Allow?", message: "Really?" });
        return;
      }
      if (cmd.message === "__slow__") return; // never answered
      respond(cmd, { disposition: "started" });
      return setImmediate(() => runPrompt(cmd.message));
    default:
      return out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: `Unknown command: ${cmd.type}` });
  }
}
