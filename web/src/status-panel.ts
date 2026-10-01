/**
 * Extension status chips and text widgets (pi setStatus / setWidget), forwarded
 * by the porcupine CLI as porcupine_ui_* events, plus the setTitle override.
 */
import { el } from "./render.js";

type Rec = Record<string, unknown>;

export class StatusPanel {
  readonly status = new Map<string, string>();
  readonly widgets = new Map<string, string[]>();
  title: string | null = null;

  /** Returns true when the visible state changed. */
  apply(e: Rec): boolean {
    switch (e.type) {
      case "porcupine_ui_status": {
        if (typeof e.key !== "string") return false;
        if (typeof e.text === "string") this.status.set(e.key, e.text);
        else this.status.delete(e.key);
        return true;
      }
      case "porcupine_ui_widget": {
        if (typeof e.key !== "string") return false;
        if (Array.isArray(e.lines)) this.widgets.set(e.key, e.lines.filter((l): l is string => typeof l === "string"));
        else this.widgets.delete(e.key);
        return true;
      }
      case "porcupine_ui_title":
        if (typeof e.title !== "string") return false;
        this.title = e.title || null;
        return true;
      case "porcupine_ui_snapshot":
        if (!Array.isArray(e.events)) return false;
        this.clear();
        for (const x of e.events) if (typeof x === "object" && x !== null) this.apply(x as Rec);
        return true;
      default:
        return false;
    }
  }

  clear(): void {
    this.status.clear();
    this.widgets.clear();
    this.title = null;
  }

  get empty(): boolean {
    return this.status.size === 0 && this.widgets.size === 0;
  }

  /** Rebuilds the panel's children; hides it when there is nothing to show. */
  render(root: HTMLElement): void {
    const children: HTMLElement[] = [];
    if (this.status.size > 0) {
      const chips = el("div", { class: "status-chips" });
      for (const [key, text] of this.status) chips.append(el("span", { class: "status-chip", "data-key": key }, text));
      children.push(chips);
    }
    for (const [key, lines] of this.widgets) {
      children.push(el("pre", { class: "status-widget", "data-key": key }, lines.join("\n")));
    }
    root.replaceChildren(...children);
    root.hidden = this.empty;
  }
}
