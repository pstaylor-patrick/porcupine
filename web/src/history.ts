/** Session history (pi get_tree) as an indented list with fork actions. */
import { el } from "./render.js";

export interface HistoryRow {
  id: string;
  depth: number;
  role: "user" | "assistant";
  text: string;
  /** On the path from the root to the current leaf. */
  current: boolean;
  leaf: boolean;
}

interface TreeNode {
  entry?: { id?: unknown; type?: unknown; message?: { role?: unknown; content?: unknown } };
  children?: unknown;
}

const SNIPPET = 80;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
    .join(" ");
}

function snippet(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > SNIPPET ? `${one.slice(0, SNIPPET - 3)}...` : one;
}

/**
 * Flattens the tree to user and assistant messages. Depth grows only where
 * the history branches, so a long linear chat stays flat.
 */
export function flattenTree(data: unknown): HistoryRow[] {
  const d = typeof data === "object" && data !== null ? (data as { tree?: unknown; leafId?: unknown }) : {};
  const roots = Array.isArray(d.tree) ? (d.tree as TreeNode[]) : [];
  const leafId = typeof d.leafId === "string" ? d.leafId : null;
  const rows: HistoryRow[] = [];
  const parent = new Map<string, string | null>();

  // Iterative walk: deep linear histories would overflow a recursive one.
  interface Frame {
    node: TreeNode;
    depth: number;
    parentId: string | null;
  }
  const stack: Frame[] = roots.map((node) => ({ node, depth: roots.length > 1 ? 1 : 0, parentId: null })).reverse();
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    const { node, depth, parentId } = frame;
    const e = node.entry;
    const id = typeof e?.id === "string" ? e.id : "";
    if (id) parent.set(id, parentId);
    const role = e?.type === "message" ? e.message?.role : undefined;
    if (id && (role === "user" || role === "assistant")) {
      const text = snippet(textOf(e?.message?.content));
      if (text || role === "user") rows.push({ id, depth, role, text: text || "(attachment)", current: false, leaf: id === leafId });
    }
    const kids = Array.isArray(node.children) ? (node.children as TreeNode[]) : [];
    const next = kids.length > 1 ? depth + 1 : depth;
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid) stack.push({ node: kid, depth: next, parentId: id || parentId });
    }
  }
  const onPath = new Set<string>();
  for (let id = leafId; id !== null && !onPath.has(id); id = parent.get(id) ?? null) onPath.add(id);
  for (const r of rows) r.current = onPath.has(r.id);
  return rows;
}

export interface HistoryActions {
  fork(entryId: string): void;
}

export function renderHistory(root: HTMLElement, rows: HistoryRow[], actions: HistoryActions): void {
  if (rows.length === 0) {
    root.replaceChildren(el("li", { class: "history-empty" }, "No messages yet"));
    return;
  }
  root.replaceChildren(
    ...rows.map((r) => {
      const li = el("li", { class: "history-row", "data-depth": String(Math.min(r.depth, 6)), "data-role": r.role });
      if (r.current) li.classList.add("current");
      if (r.leaf) li.setAttribute("aria-current", "true");
      li.append(el("span", { class: "history-text" }, `${r.role === "user" ? "You" : "pi"}: ${r.text}`));
      if (r.role === "user") {
        const b = el("button", { type: "button", class: "secondary history-fork", "aria-label": `Fork from: ${r.text}` }, "Fork here");
        b.addEventListener("click", () => actions.fork(r.id));
        li.append(b);
      }
      return li;
    }),
  );
}
