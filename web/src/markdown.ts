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

const SVG_NS = "http://www.w3.org/2000/svg";
// Phosphor "copy", "check" and "gear" (regular).
const COPY_PATH = "M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z";
const CHECK_PATH = "M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z";

export const GEAR_PATH = "M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z";

export function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ width: "18", height: "18", viewBox: "0 0 256 256", fill: "currentColor", "aria-hidden": "true", focusable: "false" })) {
    svg.setAttribute(k, v);
  }
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

/** A fenced code block with a copy button that stays in view while the block scrolls past. */
function codeBlock(text: string, lang: string): HTMLElement {
  const pre = el("pre", { class: "code" }, el("code", {}, text));
  if (lang) pre.dataset.lang = lang;
  const copy = el("button", { type: "button", class: "copy-code", "aria-label": "Copy code" });
  copy.append(icon(COPY_PATH));
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(text).then(() => {
      copy.replaceChildren(icon(CHECK_PATH));
      copy.setAttribute("aria-label", "Copied");
      setTimeout(() => {
        copy.replaceChildren(icon(COPY_PATH));
        copy.setAttribute("aria-label", "Copy code");
      }, 1500);
    });
  });
  return el("div", { class: "code-block" }, copy, pre);
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
      frag.append(codeBlock(body.join("\n"), lang));
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
