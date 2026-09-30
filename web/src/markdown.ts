/**
 * A small Markdown subset for assistant text. It builds DOM nodes directly and
 * never parses HTML, so model output cannot inject markup. Links are limited
 * to http(s) and mailto.
 */
import { el } from "./render.js";

/** Models sometimes emit LaTeX for simple symbols; show the Unicode glyph instead. */
const LATEX_SYMBOLS: Record<string, string> = {
  rightarrow: "→", to: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔",
  Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⇒", iff: "⇔",
  uparrow: "↑", downarrow: "↓", mapsto: "↦",
  times: "×", div: "÷", pm: "±", cdot: "·", approx: "≈", neq: "≠", ne: "≠",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", infty: "∞", checkmark: "✓", ldots: "...", dots: "...",
};
const LATEX_RE = new RegExp(`\\$?\\\\(${Object.keys(LATEX_SYMBOLS).join("|")})(?![A-Za-z])\\$?`, "g");

export function replaceLatexSymbols(text: string): string {
  return text.replace(LATEX_RE, (match, name: string) => LATEX_SYMBOLS[name] ?? match);
}

const SAFE_URL = /^(https?:|mailto:)/i;
// Order matters: code first so its contents are never styled.
const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\s][^*\n]*\*|(?<![\w])_[^_\s][^_\n]*_(?![\w]))|(\[[^\]\n]+\]\([^)\s]+\))/g;

export function inline(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const [tok] = m;
    const start = m.index ?? 0;
    if (start > last) frag.append(replaceLatexSymbols(text.slice(last, start)));
    last = start + tok.length;
    if (m[1]) frag.append(el("code", {}, tok.slice(1, -1)));
    else if (m[2]) frag.append(el("strong", {}, inline(tok.slice(2, -2))));
    else if (m[3]) frag.append(el("del", {}, inline(tok.slice(2, -2))));
    else if (m[4]) frag.append(el("em", {}, inline(tok.slice(1, -1))));
    else {
      const close = tok.indexOf("](");
      const label = tok.slice(1, close);
      const href = tok.slice(close + 2, -1);
      frag.append(SAFE_URL.test(href) ? el("a", { href, target: "_blank", rel: "noopener noreferrer" }, inline(label)) : tok);
    }
  }
  if (last < text.length) frag.append(replaceLatexSymbols(text.slice(last)));
  return frag;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*```/;
const HEADING_TAGS = ["h3", "h4", "h5", "h6"] as const;

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || LIST_ITEM.test(line) || line.startsWith(">");
}

export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++; // closing fence, or past the end while streaming
      const pre = el("pre", { class: "code" }, el("code", {}, body.join("\n")));
      if (lang) pre.dataset.lang = lang;
      frag.append(pre);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      // Chat text sits under the page title, so # maps to h3.
      const tag = HEADING_TAGS[Math.min((heading[1] ?? "#").length, HEADING_TAGS.length) - 1] ?? "h6";
      frag.append(el(tag, { class: "md-heading" }, inline(heading[2] ?? "")));
      i++;
      continue;
    }
    if (RULE.test(line)) {
      frag.append(el("hr", {}));
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) quoted.push((lines[i++] ?? "").replace(/^>\s?/, ""));
      frag.append(el("blockquote", {}, renderMarkdown(quoted.join("\n"))));
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2] ?? "");
      const list = el(ordered ? "ol" : "ul", { class: "md-list" });
      if (ordered) list.setAttribute("start", String(parseInt(item[2] ?? "1", 10)));
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i] ?? "");
        if (!m || /\d/.test(m[2] ?? "") !== ordered) break;
        const li = el("li", {}, inline(m[3] ?? ""));
        i++;
        // Indented continuation lines belong to the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? "") && !LIST_ITEM.test(lines[i] ?? "")) {
          li.append(el("br", {}), inline((lines[i++] ?? "").trim()));
        }
        list.append(li);
      }
      frag.append(list);
      continue;
    }
    const p = el("p", { class: "prose" });
    let first = true;
    while (i < lines.length && (lines[i] ?? "").trim() && (first || !isBlockStart(lines[i] ?? ""))) {
      if (!first) p.append(el("br", {}));
      p.append(inline(lines[i++] ?? ""));
      first = false;
    }
    frag.append(p);
  }
  return frag;
}
