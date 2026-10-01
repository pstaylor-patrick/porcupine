/**
 * Subagent children as collapsible blocks inside the subagent tool card:
 * one <details> per child with name, model, status, a tail of its streamed
 * output and its usage. Text only, via textContent.
 */
import { el } from "./render.js";

export const TAIL_LINES = 12;

type Rec = Record<string, unknown>;

export interface ChildView {
  agent: string;
  model: string;
  status: "running" | "done" | "error";
  step: number | null;
  task: string;
  tail: string;
  usage: string;
}

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Text parts and tool calls of the child's assistant messages, last TAIL_LINES lines. */
function tailOf(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const lines: string[] = [];
  for (const m of messages) {
    if (!isRec(m) || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!isRec(part)) continue;
      if (part.type === "text") lines.push(...str(part.text).split("\n"));
      else if (part.type === "toolCall") lines.push(`→ ${str(part.name)}`);
    }
  }
  return lines.slice(-TAIL_LINES).join("\n").trim();
}

export function childViews(details: unknown): ChildView[] {
  if (!isRec(details) || !Array.isArray(details.results)) return [];
  return details.results.filter(isRec).map((r) => {
    const exit = num(r.exitCode);
    const failed = exit > 0 || r.stopReason === "error" || r.stopReason === "aborted";
    const u = isRec(r.usage) ? r.usage : {};
    const parts: string[] = [];
    if (num(u.turns)) parts.push(`${num(u.turns)} turn${num(u.turns) > 1 ? "s" : ""}`);
    if (num(u.input)) parts.push(`↑${tokens(num(u.input))}`);
    if (num(u.output)) parts.push(`↓${tokens(num(u.output))}`);
    if (num(u.cost)) parts.push(`$${num(u.cost).toFixed(4)}`);
    const errText = str(r.errorMessage) || (failed && !tailOf(r.messages) ? str(r.stderr).trim() : "");
    return {
      agent: str(r.agent) || "agent",
      model: [str(r.provider), str(r.model)].filter(Boolean).join("/"),
      status: exit === -1 ? "running" : failed ? "error" : "done",
      step: typeof r.step === "number" ? r.step : null,
      task: str(r.task),
      tail: errText ? `${tailOf(r.messages)}\n${errText}`.trim() : tailOf(r.messages),
      usage: parts.join(" "),
    };
  });
}

export function renderSubagentChildren(details: unknown, open: Set<string>, toolId: string): HTMLElement | null {
  const views = childViews(details);
  if (views.length === 0) return null;
  const wrap = el("div", { class: "subagents" });
  views.forEach((v, i) => {
    const key = `subagent:${toolId}:${i}`;
    const d = el("details", { class: `subagent subagent-${v.status}` });
    d.open = open.has(key);
    d.addEventListener("toggle", () => {
      if (d.open) open.add(key);
      else open.delete(key);
    });
    const label = v.step !== null ? `${v.step}. ${v.agent}` : v.agent;
    d.append(
      el(
        "summary",
        {},
        el("span", { class: "subagent-name" }, label),
        el("span", { class: "subagent-model" }, v.model),
        el("span", { class: "subagent-status" }, v.status),
      ),
    );
    if (v.task) d.append(el("div", { class: "subagent-task" }, v.task));
    d.append(el("pre", { class: "subagent-tail" }, v.tail || (v.status === "running" ? "(running...)" : "(no output)")));
    if (v.usage) d.append(el("div", { class: "subagent-usage" }, v.usage));
    wrap.append(d);
  });
  return wrap;
}
