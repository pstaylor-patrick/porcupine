// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ASK_TITLE_PREFIX, DialogQueue, parseDialog, renderDialog, type DialogAnswer } from "../src/questions.js";

const ask = {
  type: "extension_ui_request",
  id: "q1",
  method: "input",
  title:
    ASK_TITLE_PREFIX +
    JSON.stringify({
      questions: [
        { question: "Order?", header: "Order", options: [{ label: "Markdown", description: "quick" }, { label: "Sheet" }] },
        { question: "Parts?", header: "Parts", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
      ],
    }),
};

function answerOf(req: Record<string, unknown>, act: (form: HTMLElement) => void): DialogAnswer | undefined {
  const d = parseDialog(req);
  if (!d) throw new Error("no dialog");
  let got: DialogAnswer | undefined;
  const { body } = renderDialog(d, (a) => (got = a));
  document.body.replaceChildren(body);
  act(body);
  return got;
}

const click = (root: HTMLElement, sel: string, i = 0): void => {
  (root.querySelectorAll<HTMLElement>(sel)[i] as HTMLElement).click();
};

describe("questions", () => {
  it("parses the ask_user_question title and falls back to a plain input", () => {
    expect(parseDialog(ask)?.kind).toBe("ask");
    expect(parseDialog({ ...ask, title: ASK_TITLE_PREFIX + "{bad" })?.kind).toBe("input");
    expect(parseDialog({ type: "extension_ui_request", id: "n", method: "notify" })).toBeNull();
  });

  it("answers with JSON once every question has an answer, including typed Other", () => {
    const a = answerOf(ask, (form) => {
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      expect(submit?.disabled).toBe(true);
      click(form, 'input[name="q0"]', 0);
      expect(submit?.textContent).toBe("Next");
      (form as HTMLFormElement).requestSubmit();
      expect(submit?.textContent).toBe("Submit");
      expect(form.querySelectorAll<HTMLElement>("fieldset")[0]?.hidden).toBe(true);
      click(form, 'input[name="q1"]', 1);
      const other = form.querySelectorAll<HTMLInputElement>(".other-text")[1] as HTMLInputElement;
      other.value = "C";
      other.dispatchEvent(new Event("input"));
      expect(submit?.disabled).toBe(false);
      (form as HTMLFormElement).requestSubmit();
    });
    expect(a).toEqual({
      type: "extension_ui_response",
      id: "q1",
      value: JSON.stringify({ answers: { "Order?": "Markdown", "Parts?": "B, C" } }),
    });
  });

  it("maps select, confirm and dismiss to pi's response shapes", () => {
    const sel = { type: "extension_ui_request", id: "s", method: "select", title: "Pick", options: ["x", "y"] };
    expect(answerOf(sel, (f) => click(f, ".dialog-option", 1))).toEqual({ type: "extension_ui_response", id: "s", value: "y" });
    const conf = { type: "extension_ui_request", id: "c", method: "confirm", title: "Sure?", message: "m" };
    expect(answerOf(conf, (f) => click(f, "button", 0))).toEqual({ type: "extension_ui_response", id: "c", confirmed: false });
    expect(answerOf(sel, (f) => click(f, ".dialog-actions button", 0))).toEqual({ type: "extension_ui_response", id: "s", cancelled: true });
  });

  it("tracks open dialogs from the event stream", () => {
    const q = new DialogQueue();
    expect(q.apply(ask)).toBe(true);
    expect(q.current?.id).toBe("q1");
    expect(q.apply({ type: "porcupine_ui_resolved", id: "q1" })).toBe(true);
    expect(q.current).toBeNull();
    q.apply(ask);
    expect(q.apply({ type: "agent_settled" })).toBe(true);
    expect(q.current).toBeNull();
  });

  it("never renders question text as HTML", () => {
    const evil = { ...ask, title: ASK_TITLE_PREFIX + JSON.stringify({ questions: [{ question: "<img src=x>", header: "", options: [{ label: "<b>x</b>" }] }] }) };
    answerOf(evil, () => undefined);
    expect(document.querySelector("img, b")).toBeNull();
  });
});
