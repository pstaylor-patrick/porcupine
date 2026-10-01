/**
 * Extension dialogs forwarded by the porcupine CLI: pi's select, confirm,
 * input and editor, plus the ask_user_question tool's multi-question form,
 * which arrives as an input dialog whose title carries JSON.
 */
import { el } from "./render.js";

/** Keep in sync with hub/src/extension/ask-user-question.ts. */
export const ASK_TITLE_PREFIX = "porcupine.ask_user_question/1 ";

export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export type Dialog =
  | { kind: "ask"; id: string; questions: AskQuestion[] }
  | { kind: "select"; id: string; title: string; options: string[] }
  | { kind: "confirm"; id: string; title: string; message: string }
  | { kind: "input"; id: string; title: string; placeholder: string; prefill: string };

export type DialogAnswer =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

type Rec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;

function parseQuestions(json: string): AskQuestion[] | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRec(data) || !Array.isArray(data.questions)) return null;
  const questions: AskQuestion[] = [];
  for (const q of data.questions) {
    if (!isRec(q) || typeof q.question !== "string" || !Array.isArray(q.options)) return null;
    const options = q.options.filter(isRec).map((o) => ({ label: str(o.label), description: str(o.description) }));
    questions.push({ question: q.question, header: str(q.header), options, multiSelect: q.multiSelect === true });
  }
  return questions.length > 0 ? questions : null;
}

/** Reads an extension_ui_request event; null for fire-and-forget methods and malformed requests. */
export function parseDialog(e: Rec): Dialog | null {
  const id = str(e.id);
  const title = str(e.title);
  if (e.type !== "extension_ui_request" || !id) return null;
  switch (e.method) {
    case "select":
      return Array.isArray(e.options) ? { kind: "select", id, title, options: e.options.map(str) } : null;
    case "confirm":
      return { kind: "confirm", id, title, message: str(e.message) };
    case "input":
    case "editor": {
      if (title.startsWith(ASK_TITLE_PREFIX)) {
        const questions = parseQuestions(title.slice(ASK_TITLE_PREFIX.length));
        if (questions) return { kind: "ask", id, questions };
      }
      return { kind: "input", id, title, placeholder: str(e.placeholder), prefill: str(e.prefill) };
    }
    default:
      return null;
  }
}

/** Open dialogs in arrival order, driven by the event stream so replays rebuild them. */
export class DialogQueue {
  private readonly open = new Map<string, Dialog>();

  /** Returns true when the set of open dialogs changed. */
  apply(e: Rec): boolean {
    if (e.type === "extension_ui_request") {
      const d = parseDialog(e);
      if (!d) return false;
      this.open.set(d.id, d);
      return true;
    }
    if (e.type === "porcupine_ui_resolved") return this.open.delete(str(e.id));
    if (e.type === "agent_settled" && this.open.size > 0) {
      this.open.clear();
      return true;
    }
    return false;
  }

  get current(): Dialog | null {
    return this.open.values().next().value ?? null;
  }

  clear(): void {
    this.open.clear();
  }
}

const OTHER = "\u0000other";

type Answer = (a: DialogAnswer) => void;
interface Rendered {
  title: string;
  body: HTMLElement;
}

function button(label: string, cls: string, type: "button" | "submit" = "button"): HTMLButtonElement {
  return el("button", { type, class: cls }, label);
}

function onSubmit(form: HTMLFormElement, fn: () => void): void {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    fn();
  });
}

function dismissButton(id: string, answer: Answer): HTMLButtonElement {
  const b = button("Dismiss", "secondary");
  b.addEventListener("click", () => answer({ type: "extension_ui_response", id, cancelled: true }));
  return b;
}

function renderConfirm(d: Extract<Dialog, { kind: "confirm" }>, answer: Answer): Rendered {
  const form = el("form", { class: "dialog-form" });
  if (d.message) form.append(el("p", { class: "dialog-message" }, d.message));
  const no = button("No", "secondary");
  no.addEventListener("click", () => answer({ type: "extension_ui_response", id: d.id, confirmed: false }));
  onSubmit(form, () => answer({ type: "extension_ui_response", id: d.id, confirmed: true }));
  form.append(el("div", { class: "dialog-actions" }, no, button("Yes", "primary", "submit")));
  return { title: d.title || "Confirm", body: form };
}

function renderSelect(d: Extract<Dialog, { kind: "select" }>, answer: Answer): Rendered {
  const list = el("div", { class: "dialog-options" });
  for (const o of d.options) {
    const b = button(o, "dialog-option");
    b.addEventListener("click", () => answer({ type: "extension_ui_response", id: d.id, value: o }));
    list.append(b);
  }
  const form = el("form", { class: "dialog-form" }, list, el("div", { class: "dialog-actions" }, dismissButton(d.id, answer)));
  return { title: d.title || "Choose", body: form };
}

function renderInput(d: Extract<Dialog, { kind: "input" }>, answer: Answer): Rendered {
  const area = el("textarea", { class: "dialog-text", rows: "3", placeholder: d.placeholder, "aria-label": d.title || "Answer" });
  area.value = d.prefill;
  const form = el("form", { class: "dialog-form" }, area);
  onSubmit(form, () => answer({ type: "extension_ui_response", id: d.id, value: area.value }));
  form.append(el("div", { class: "dialog-actions" }, dismissButton(d.id, answer), button("Submit", "primary", "submit")));
  return { title: d.title || "Answer", body: form };
}

/** One question's fieldset, plus a reader returning its answer ("" while unanswered). */
function questionField(q: AskQuestion, name: string, changed: () => void): { set: HTMLFieldSetElement; read: () => string } {
  const set = el("fieldset", { class: "question" });
  const legend = el("legend", {}, q.question);
  if (q.header) legend.prepend(el("span", { class: "q-chip" }, q.header));
  set.append(legend);
  const type = q.multiSelect ? "checkbox" : "radio";
  const choice = (value: string, label: Node): HTMLLabelElement => {
    const text = el("span", { class: "choice-text" }, label);
    return el("label", { class: "choice" }, el("input", { type, name, value }), text);
  };
  for (const o of q.options) {
    const c = choice(o.label, el("span", { class: "choice-label" }, o.label));
    if (o.description) c.lastElementChild?.append(el("span", { class: "choice-desc" }, o.description));
    set.append(c);
  }
  const other = el("input", { type: "text", class: "other-text", placeholder: "Other", "aria-label": `Other answer to: ${q.question}` });
  const otherChoice = choice(OTHER, other);
  set.append(otherChoice);
  // Typing an answer selects Other.
  other.addEventListener("input", () => {
    const box = otherChoice.querySelector("input");
    if (box) box.checked = other.value.trim() !== "";
    changed();
  });
  set.addEventListener("change", changed);
  const read = (): string =>
    [...set.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)]
      .map((i) => (i.value === OTHER ? other.value.trim() : i.value))
      .filter(Boolean)
      .join(", ");
  return { set, read };
}

/**
 * A wizard: one question per step, with tabs across the top like Claude Code.
 * Picking a single-select option moves on; the last step's button submits.
 */
function renderAsk(d: Extract<Dialog, { kind: "ask" }>, answer: Answer): Rendered {
  const form = el("form", { class: "dialog-form ask-wizard" });
  const n = d.questions.length;
  let step = 0;
  const next = button("Next", "primary", "submit");
  const back = button("Back", "secondary");
  const tabs = el("div", { class: "ask-steps", role: "tablist" });
  const tabButtons = d.questions.map((q, i) => {
    const t = el("button", { type: "button", class: "ask-step", role: "tab" }, q.header || `Q${String(i + 1)}`);
    t.addEventListener("click", () => go(i));
    return t;
  });
  tabs.append(...tabButtons);
  const sync = (): void => {
    fields.forEach((f, i) => {
      f.set.hidden = i !== step;
      const t = tabButtons[i];
      if (!t) return;
      t.setAttribute("aria-selected", String(i === step));
      t.dataset.done = String(f.read() !== "");
    });
    const last = step === n - 1;
    next.textContent = last ? "Submit" : "Next";
    next.disabled = last ? fields.some((f) => !f.read()) : !fields[step]?.read();
    back.hidden = step === 0;
  };
  const go = (i: number): void => {
    step = Math.max(0, Math.min(n - 1, i));
    sync();
    fields[step]?.set.querySelector<HTMLElement>("input")?.focus({ preventScroll: true });
  };
  const fields = d.questions.map((q, i) =>
    questionField(q, `q${String(i)}`, () => {
      sync();
      // A single choice is the whole answer; typed Other waits for Next.
      const picked = fields[i]?.set.querySelector<HTMLInputElement>(`input[name="q${String(i)}"]:checked`);
      if (!q.multiSelect && picked && picked.value !== OTHER && i === step && i < n - 1) setTimeout(() => go(i + 1), 150);
    }),
  );
  back.addEventListener("click", () => go(step - 1));
  if (n > 1) form.append(tabs);
  form.append(...fields.map((f) => f.set));
  sync();
  onSubmit(form, () => {
    if (next.disabled) return;
    if (step < n - 1) return go(step + 1);
    const answers: Record<string, string> = {};
    d.questions.forEach((q, i) => (answers[q.question] = fields[i]?.read() ?? ""));
    answer({ type: "extension_ui_response", id: d.id, value: JSON.stringify({ answers }) });
  });
  form.append(el("div", { class: "dialog-actions" }, dismissButton(d.id, answer), back, next));
  return { title: n > 1 ? "Questions" : "Question", body: form };
}

/** Builds the form for one dialog. `answer` fires at most once, so a double tap sends one reply. */
export function renderDialog(d: Dialog, answer: Answer): Rendered {
  let sent = false;
  const once: Answer = (a) => {
    if (sent) return;
    sent = true;
    answer(a);
  };
  switch (d.kind) {
    case "confirm":
      return renderConfirm(d, once);
    case "select":
      return renderSelect(d, once);
    case "input":
      return renderInput(d, once);
    case "ask":
      return renderAsk(d, once);
  }
}
