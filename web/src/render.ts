/** DOM rendering. Model output only ever reaches the DOM through textContent / text nodes. */
import { renderMarkdown } from "./markdown.js";
import { renderSubagentChildren } from "./subagent.js";
import type { Item, ToolState, Transcript } from "./transcript.js";

export const ARGS_LIMIT = 2048;
export const OUTPUT_LIMIT = 4096;

type Attrs = Record<string, string>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

/** Splits text into paragraphs, fenced code blocks and inline code spans, all as text nodes. */
export function formatText(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const lang = nl > 0 ? part.slice(0, nl).trim() : "";
      const body = nl >= 0 && /^[\w+-]*$/.test(lang) ? part.slice(nl + 1) : part;
      const pre = el("pre", { class: "code" }, el("code", {}, body.replace(/\n$/, "")));
      if (lang) pre.dataset.lang = lang;
      frag.append(pre);
      return;
    }
    if (!part) return;
    const p = el("div", { class: "prose" });
    part.split(/(`[^`\n]+`)/).forEach((seg) => {
      if (seg.length > 2 && seg.startsWith("`") && seg.endsWith("`")) p.append(el("code", {}, seg.slice(1, -1)));
      else if (seg) p.append(document.createTextNode(seg));
    });
    frag.append(p);
  });
  return frag;
}

/** A pre block that truncates long text with an expand button. */
function truncated(text: string, limit: number, cls: string): HTMLElement {
  const wrap = el("div", { class: cls });
  const pre = el("pre", {});
  wrap.append(pre);
  if (text.length <= limit) {
    pre.textContent = text;
    return wrap;
  }
  pre.textContent = text.slice(0, limit) + "\n…";
  const more = el("button", { type: "button", class: "link" }, `Show all (${text.length.toLocaleString()} chars)`);
  more.addEventListener("click", () => {
    pre.textContent = text;
    more.remove();
  });
  wrap.append(more);
  return wrap;
}

const STATUS_LABEL: Record<ToolState["status"], string> = {
  pending: "pending",
  running: "running",
  done: "done",
  error: "error",
};

export function renderTool(s: ToolState, open: Set<string>): HTMLElement {
  const details = el("details", { class: `tool tool-${s.status}` });
  details.open = open.has(`tool:${s.id}`);
  details.addEventListener("toggle", () => {
    if (details.open) open.add(`tool:${s.id}`);
    else open.delete(`tool:${s.id}`);
  });
  const summary = el(
    "summary",
    {},
    el("span", { class: "tool-name" }, s.name || "tool"),
    el("span", { class: "tool-status" }, STATUS_LABEL[s.status]),
  );
  details.append(summary);
  if (s.argsText) details.append(truncated(s.argsText, ARGS_LIMIT, "tool-args"));
  const children = s.name === "subagent" ? renderSubagentChildren(s.details, open, s.id) : null;
  if (children) {
    details.append(children);
    if (s.status === "running") return details;
  }
  if (s.output) details.append(truncated(s.output, OUTPUT_LIMIT, "tool-output"));
  return details;
}

export function renderItem(item: Item, t: Transcript, open: Set<string>): HTMLElement {
  switch (item.kind) {
    case "user":
      return el("article", { class: "msg user", "aria-label": "You" }, formatText(item.text));
    case "notice":
      return el("div", { class: `notice notice-${item.level}`, role: "note" }, item.text);
    case "status":
      return el("div", { class: "status-line" }, item.text);
    case "assistant": {
      const art = el("article", { class: "msg assistant", "aria-label": "Assistant" });
      item.blocks.forEach((b, i) => {
        if (!b) return;
        if (b.type === "text") {
          if (b.text) art.append(renderMarkdown(b.text));
        } else if (b.type === "thinking") {
          if (!b.text) return;
          const id = `think:${item.key}:${i}`;
          const d = el("details", { class: "thinking" }, el("summary", {}, "Thinking"), el("pre", {}, b.text));
          d.open = open.has(id);
          d.addEventListener("toggle", () => {
            if (d.open) open.add(id);
            else open.delete(id);
          });
          art.append(d);
        } else {
          const s = t.tools.get(b.id);
          if (s) art.append(renderTool(s, open));
        }
      });
      if (item.error) art.append(el("div", { class: "notice notice-error", role: "note" }, item.error));
      return art;
    }
  }
}

/** Keyed renderer: re-renders only items whose version changed. */
export class TranscriptView {
  private nodes = new Map<number, { version: number; node: HTMLElement }>();
  readonly open = new Set<string>();

  constructor(private readonly root: HTMLElement) {}

  clear(): void {
    this.nodes.clear();
    this.root.replaceChildren();
  }

  render(t: Transcript): void {
    const seen = new Set<number>();
    let prev: HTMLElement | null = null;
    for (const item of t.items) {
      seen.add(item.key);
      const cached = this.nodes.get(item.key);
      let node: HTMLElement;
      if (cached && cached.version === item.version) node = cached.node;
      else {
        node = renderItem(item, t, this.open);
        if (cached) cached.node.replaceWith(node);
        this.nodes.set(item.key, { version: item.version, node });
      }
      const want: ChildNode | null = prev ? prev.nextSibling : this.root.firstChild;
      if (want !== node) this.root.insertBefore(node, want);
      prev = node;
    }
    for (const [key, { node }] of this.nodes) {
      if (!seen.has(key)) {
        node.remove();
        this.nodes.delete(key);
      }
    }
  }
}
