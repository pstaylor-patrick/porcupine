/** Pure transcript model: builds a renderable list from pi events or from get_messages. */

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id: string };

export interface ToolState {
  id: string;
  name: string;
  args: unknown;
  argsText: string;
  status: "pending" | "running" | "done" | "error";
  output: string;
}

export type Item =
  | { key: number; version: number; kind: "user"; text: string; msgKey: string | null }
  | { key: number; version: number; kind: "assistant"; blocks: Block[]; msgKey: string | null; error: string | null }
  | { key: number; version: number; kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { key: number; version: number; kind: "status"; text: string };

export interface Transcript {
  items: Item[];
  tools: Map<string, ToolState>;
  /** Assistant item key that owns each tool call, so tool updates re-render the card. */
  toolOwner: Map<string, number>;
  current: number | null;
  isStreaming: boolean;
  nextKey: number;
  /** Message keys already present from get_messages; replayed copies are merged, not duplicated. */
  known: Set<string>;
  skipping: boolean;
}

type Rec = Record<string, unknown>;

export function emptyTranscript(): Transcript {
  return {
    items: [],
    tools: new Map(),
    toolOwner: new Map(),
    current: null,
    isStreaming: false,
    nextKey: 1,
    known: new Set(),
    skipping: false,
  };
}

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function messageKey(m: Rec): string | null {
  return typeof m.timestamp === "number" ? `${str(m.role)}:${m.timestamp}` : null;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (!isRec(c)) continue;
    if (c.type === "text") parts.push(str(c.text));
    else if (c.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

function jsonText(v: unknown): string {
  if (v === undefined) return "";
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}

function resultText(result: unknown): string {
  if (isRec(result)) return contentText(result.content);
  return typeof result === "string" ? result : jsonText(result);
}

function push<T extends Omit<Item, "key" | "version">>(t: Transcript, item: T): Item {
  const full = { ...item, key: t.nextKey++, version: 1 } as unknown as Item;
  t.items.push(full);
  return full;
}

function find(t: Transcript, key: number | null): Item | undefined {
  if (key === null) return undefined;
  return t.items.find((i) => i.key === key);
}

function touch(item: Item | undefined): void {
  if (item) item.version++;
}

function tool(t: Transcript, id: string, name: string): ToolState {
  let s = t.tools.get(id);
  if (!s) {
    s = { id, name, args: undefined, argsText: "", status: "pending", output: "" };
    t.tools.set(id, s);
  }
  if (name && !s.name) s.name = name;
  return s;
}

function touchTool(t: Transcript, id: string): void {
  touch(find(t, t.toolOwner.get(id) ?? null));
}

function assistantBlocks(t: Transcript, ownerKey: number, content: unknown): Block[] {
  const blocks: Block[] = [];
  if (!Array.isArray(content)) return blocks;
  for (const c of content) {
    if (!isRec(c)) continue;
    if (c.type === "text") blocks.push({ type: "text", text: str(c.text) });
    else if (c.type === "thinking") blocks.push({ type: "thinking", text: str(c.thinking) });
    else if (c.type === "toolCall") {
      const id = str(c.id);
      const s = tool(t, id, str(c.name));
      s.args = c.arguments;
      s.argsText = jsonText(c.arguments);
      t.toolOwner.set(id, ownerKey);
      blocks.push({ type: "toolCall", id });
    }
  }
  return blocks;
}

function newAssistant(t: Transcript, msgKey: string | null): Item & { kind: "assistant" } {
  const item = push(t, { kind: "assistant", blocks: [], msgKey, error: null }) as Item & { kind: "assistant" };
  t.current = item.key;
  return item;
}

function currentAssistant(t: Transcript): (Item & { kind: "assistant" }) | null {
  const item = find(t, t.current);
  return item && item.kind === "assistant" ? item : null;
}

function byMsgKey(t: Transcript, key: string | null): Item | undefined {
  if (key === null) return undefined;
  return t.items.find((i) => (i.kind === "user" || i.kind === "assistant") && i.msgKey === key);
}

function finishAssistant(t: Transcript, item: Item & { kind: "assistant" }, m: Rec): void {
  item.blocks = assistantBlocks(t, item.key, m.content);
  item.msgKey = messageKey(m);
  item.error = m.stopReason === "error" ? str(m.errorMessage) || "model error" : null;
  if (m.stopReason === "aborted") item.error = "aborted";
  touch(item);
}

function applyToolResultMessage(t: Transcript, m: Rec): void {
  const id = str(m.toolCallId);
  const s = tool(t, id, str(m.toolName));
  s.output = contentText(m.content);
  s.status = m.isError === true ? "error" : "done";
  touchTool(t, id);
}

function addMessage(t: Transcript, m: Rec): void {
  const key = messageKey(m);
  if (key) t.known.add(key);
  if (m.role === "user") push(t, { kind: "user", text: contentText(m.content), msgKey: key });
  else if (m.role === "assistant") {
    const item = newAssistant(t, key);
    finishAssistant(t, item, m);
    t.current = null;
  } else if (m.role === "toolResult") applyToolResultMessage(t, m);
  else if (m.role === "bashExecution") {
    push(t, { kind: "status", text: `$ ${str(m.command)}` });
  } else if (m.role === "compactionSummary" || m.role === "branchSummary") {
    push(t, { kind: "status", text: m.role === "compactionSummary" ? "context compacted" : "branch summary" });
  }
}

/** Rebuilds a transcript from a get_messages response. */
export function fromMessages(messages: unknown): Transcript {
  const t = emptyTranscript();
  if (Array.isArray(messages)) for (const m of messages) if (isRec(m)) addMessage(t, m);
  return t;
}

function applyUpdate(t: Transcript, ev: Rec): void {
  if (t.skipping) return;
  const ae = ev.assistantMessageEvent;
  if (!isRec(ae)) return;
  const item = currentAssistant(t) ?? newAssistant(t, null);
  const idx = typeof ae.contentIndex === "number" ? ae.contentIndex : item.blocks.length;
  const type = str(ae.type);
  const ensure = (kind: "text" | "thinking"): Block & { text: string } => {
    const b = item.blocks[idx];
    if (b && b.type === kind) return b;
    const nb = { type: kind, text: "" };
    item.blocks[idx] = nb;
    for (let i = 0; i < idx; i++) if (!item.blocks[i]) item.blocks[i] = { type: "text", text: "" };
    return nb;
  };
  if (type === "text_start" || type === "text_delta") ensure("text").text += str(ae.delta);
  else if (type === "text_end") ensure("text").text = typeof ae.content === "string" ? ae.content : ensure("text").text;
  else if (type === "thinking_start" || type === "thinking_delta") ensure("thinking").text += str(ae.delta);
  else if (type === "thinking_end")
    ensure("thinking").text = typeof ae.content === "string" ? ae.content : ensure("thinking").text;
  else if (type === "toolcall_start") {
    const id = str(ae.id);
    tool(t, id, str(ae.toolName));
    t.toolOwner.set(id, item.key);
    item.blocks[idx] = { type: "toolCall", id };
  } else if (type === "toolcall_delta") {
    const b = item.blocks[idx];
    if (b && b.type === "toolCall") tool(t, b.id, "").argsText += str(ae.delta);
  } else if (type === "toolcall_end" && isRec(ae.toolCall)) {
    const tc = ae.toolCall;
    const id = str(tc.id);
    const s = tool(t, id, str(tc.name));
    s.args = tc.arguments;
    s.argsText = jsonText(tc.arguments);
    t.toolOwner.set(id, item.key);
    item.blocks[idx] = { type: "toolCall", id };
  } else return;
  touch(item);
}

/** Applies one pi event (or porcupine synthetic event) to the transcript in place. */
export function applyEvent(t: Transcript, ev: Rec): void {
  const type = str(ev.type);
  const m = isRec(ev.message) ? ev.message : null;
  switch (type) {
    case "agent_start":
      t.isStreaming = true;
      return;
    case "agent_settled":
      t.isStreaming = false;
      t.current = null;
      return;
    case "message_start": {
      if (!m) return;
      const key = messageKey(m);
      if (key && t.known.has(key)) {
        t.skipping = true;
        return;
      }
      t.skipping = false;
      if (key) t.known.add(key);
      if (m.role === "user") push(t, { kind: "user", text: contentText(m.content), msgKey: key });
      else if (m.role === "assistant") newAssistant(t, key);
      return;
    }
    case "message_update":
      applyUpdate(t, ev);
      return;
    case "message_end": {
      if (!m) return;
      const wasSkipping = t.skipping;
      t.skipping = false;
      const key = messageKey(m);
      if (m.role === "assistant") {
        const existing = byMsgKey(t, key);
        const item =
          existing && existing.kind === "assistant" ? existing : wasSkipping ? null : (currentAssistant(t) ?? newAssistant(t, key));
        if (item) finishAssistant(t, item, m);
        t.current = null;
      } else if (m.role === "user") {
        if (!byMsgKey(t, key) && !wasSkipping) push(t, { kind: "user", text: contentText(m.content), msgKey: key });
      } else if (m.role === "toolResult") applyToolResultMessage(t, m);
      if (key) t.known.add(key);
      return;
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const id = str(ev.toolCallId);
      const s = tool(t, id, str(ev.toolName));
      if (s.status === "done" || s.status === "error") {
        if (type !== "tool_execution_end") return;
      }
      if (ev.args !== undefined && !s.argsText) {
        s.args = ev.args;
        s.argsText = jsonText(ev.args);
      }
      if (type === "tool_execution_start") s.status = "running";
      else if (type === "tool_execution_update") {
        s.status = "running";
        s.output = resultText(ev.partialResult);
      } else {
        s.status = ev.isError === true ? "error" : "done";
        s.output = resultText(ev.result);
      }
      if (!t.toolOwner.has(id)) {
        const owner = currentAssistant(t) ?? newAssistant(t, null);
        owner.blocks.push({ type: "toolCall", id });
        t.toolOwner.set(id, owner.key);
      }
      touchTool(t, id);
      return;
    }
    case "porcupine_notice": {
      const level = ev.level === "error" || ev.level === "warn" ? ev.level : "info";
      push(t, { kind: "notice", level, text: str(ev.text) });
      return;
    }
    case "extension_error":
      push(t, { kind: "notice", level: "error", text: `extension error (${str(ev.event)}): ${str(ev.error)}` });
      return;
    case "auto_retry_start":
      push(t, { kind: "status", text: `retrying (${String(ev.attempt)}/${String(ev.maxAttempts)}): ${str(ev.errorMessage)}` });
      return;
    case "auto_retry_end":
      if (ev.success !== true) push(t, { kind: "notice", level: "error", text: `retry failed: ${str(ev.finalError)}` });
      return;
    case "compaction_start":
      push(t, { kind: "status", text: `compacting context (${str(ev.reason)})` });
      return;
    case "compaction_end":
      push(t, {
        kind: "status",
        text: ev.aborted === true ? "compaction aborted" : ev.errorMessage ? `compaction failed: ${str(ev.errorMessage)}` : "compaction done",
      });
      return;
    default:
      return;
  }
}
