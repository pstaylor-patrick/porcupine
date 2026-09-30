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

/** Builds the form for one dialog. `answer` is called once with pi's response shape. */
export function renderDialog(d: Dialog, answer: (a: DialogAnswer) => void): { title: string; body: HTMLElement } {
  const form = el("form", { class: "dialog-form" });
  const actions = el("div", { class: "dialog-actions" });
  const dismiss = el("button", { type: "button", class: "secondary" }, "Dismiss");
  dismiss.addEventListener("click", () => answer({ type: "extension_ui_response", id: d.id, cancelled: true }));

  if (d.kind === "confirm") {
    if (d.message) form.append(el("p", { class: "dialog-message" }, d.message));
    const no = el("button", { type: "button", class: "secondary" }, "No");
    const yes = el("button", { type: "submit", class: "primary" }, "Yes");
    no.addEventListener("click", () => answer({ type: "extension_ui_response", id: d.id, confirmed: false }));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      answer({ type: "extension_ui_response", id: d.id, confirmed: true });
    });
    actions.append(no, yes);
    form.append(actions);
    return { title: d.title || "Confirm", body: form };
  }

  if (d.kind === "select") {
    const list = el("div", { class: "dialog-options" });
    for (const o of d.options) {
      const b = el("button", { type: "button", class: "dialog-option" }, o);
      b.addEventListener("click", () => answer({ type: "extension_ui_response", id: d.id, value: o }));
      list.append(b);
    }
    actions.append(dismiss);
    form.append(list, actions);
    return { title: d.title || "Choose", body: form };
  }

  if (d.kind === "input") {
    const area = el("textarea", { class: "dialog-text", rows: "3", placeholder: d.placeholder, "aria-label": d.title || "Answer" });
    area.value = d.prefill;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      answer({ type: "extension_ui_response", id: d.id, value: area.value });
    });
    actions.append(dismiss, el("button", { type: "submit", class: "primary" }, "Submit"));
    form.append(area, actions);
    return { title: d.title || "Answer", body: form };
  }

  const submit = el("button", { type: "submit", class: "primary" }, "Submit");
  const readers: (() => string)[] = [];
  d.questions.forEach((q, qi) => {
    const set = el("fieldset", { class: "question" });
    const legend = el("legend", {}, q.question);
    if (q.header) legend.prepend(el("span", { class: "chip" }, q.header));
    set.append(legend);
    const type = q.multiSelect ? "checkbox" : "radio";
    const name = `q${qi}`;
    const choice = (value: string, label: string, description: string): HTMLLabelElement => {
      const input = el("input", { type, name, value });
      const text = el("span", { class: "choice-text" }, el("span", { class: "choice-label" }, label));
      if (description) text.append(el("span", { class: "choice-desc" }, description));
      return el("label", { class: "choice" }, input, text);
    };
    q.options.forEach((o) => set.append(choice(o.label, o.label, o.description ?? "")));
    const other = el("input", { type: "text", class: "other-text", placeholder: "Other", "aria-label": `Other answer to: ${q.question}` });
    const otherChoice = choice(OTHER, "Other", "");
    otherChoice.querySelector(".choice-label")?.replaceWith(other);
    set.append(otherChoice);
    // Typing an answer selects Other; choosing a listed option clears it for single-select.
    other.addEventListener("input", () => {
      const box = otherChoice.querySelector("input");
      if (box) box.checked = other.value.trim() !== "";
      sync();
    });
    set.addEventListener("change", sync);
    readers.push(() => {
      const picked = [...set.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((i) =>
        i.value === OTHER ? other.value.trim() : i.value,
      );
      return picked.filter(Boolean).join(", ");
    });
    form.append(set);
  });
  function sync(): void {
    submit.disabled = readers.some((r) => !r());
  }
  sync();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    const answers: Record<string, string> = {};
    d.questions.forEach((q, i) => (answers[q.question] = readers[i]?.() ?? ""));
    answer({ type: "extension_ui_response", id: d.id, value: JSON.stringify({ answers }) });
  });
  actions.append(dismiss, submit);
  form.append(actions);
  return { title: d.questions.length > 1 ? "Questions" : "Question", body: form };
}
