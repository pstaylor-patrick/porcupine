/** Slash-command autocomplete for the composer, fed by pi's get_commands. */
import { el } from "./render.js";

export interface SlashCommand {
  name: string;
  description: string;
  source: string;
}

const MAX_ITEMS = 8;

export function parseCommands(data: unknown): SlashCommand[] {
  const list = typeof data === "object" && data !== null ? (data as { commands?: unknown }).commands : undefined;
  if (!Array.isArray(list)) return [];
  const out: SlashCommand[] = [];
  for (const c of list) {
    if (typeof c !== "object" || c === null) continue;
    const r = c as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name) continue;
    out.push({
      name: r.name,
      description: typeof r.description === "string" ? r.description : "",
      source: typeof r.source === "string" ? r.source : "",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The command prefix being typed, or null when the input is not a bare "/name" so far. */
export function slashQuery(value: string): string | null {
  const m = /^\/(\S*)$/.exec(value);
  return m ? (m[1] ?? "") : null;
}

/** Prefix matches first, then substring matches, capped. */
export function matchCommands(cmds: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const prefix = cmds.filter((c) => c.name.toLowerCase().startsWith(q));
  const rest = q ? cmds.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)) : [];
  return [...prefix, ...rest].slice(0, MAX_ITEMS);
}

/** Listbox above the composer. The input keeps focus; arrows move the selection. */
export class CommandMenu {
  commands: SlashCommand[] = [];
  matches: SlashCommand[] = [];
  selected = 0;
  /** Set after a completion or Esc so the list stays shut until the text changes. */
  private dismissedFor: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly input: HTMLTextAreaElement,
  ) {
    root.addEventListener("pointerdown", (e) => e.preventDefault());
  }

  get open(): boolean {
    return this.matches.length > 0;
  }

  setCommands(cmds: SlashCommand[]): void {
    this.commands = cmds;
    this.update();
  }

  /** Recomputes matches from the input text. */
  update(): void {
    const value = this.input.value;
    const q = slashQuery(value);
    this.matches = q === null || this.dismissedFor === value ? [] : matchCommands(this.commands, q);
    if (this.dismissedFor !== value) this.dismissedFor = null;
    // An exact, complete match needs no menu.
    if (this.matches.length === 1 && this.matches[0]?.name === q) this.matches = [];
    this.selected = Math.min(this.selected, Math.max(0, this.matches.length - 1));
    this.render();
  }

  complete(i = this.selected): void {
    const c = this.matches[i];
    if (!c) return;
    this.input.value = `/${c.name} `;
    this.dismissedFor = this.input.value;
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
    this.update();
  }

  /** Handles a composer keydown; returns true when the menu consumed it. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.open || e.isComposing) return false;
    switch (e.key) {
      case "ArrowDown":
        this.selected = (this.selected + 1) % this.matches.length;
        break;
      case "ArrowUp":
        this.selected = (this.selected - 1 + this.matches.length) % this.matches.length;
        break;
      case "Tab":
      case "Enter":
        if (e.shiftKey) return false;
        this.complete();
        break;
      case "Escape":
        this.dismissedFor = this.input.value;
        this.matches = [];
        break;
      default:
        return false;
    }
    e.preventDefault();
    e.stopPropagation();
    this.render();
    return true;
  }

  render(): void {
    const items = this.matches.map((c, i) => {
      const li = el(
        "li",
        { id: `cmd-opt-${i}`, role: "option", class: "cmd-option", "aria-selected": String(i === this.selected) },
        el("span", { class: "cmd-name" }, `/${c.name}`),
      );
      if (c.description) li.append(el("span", { class: "cmd-desc" }, c.description));
      li.addEventListener("click", () => this.complete(i));
      return li;
    });
    this.root.replaceChildren(...items);
    this.root.hidden = !this.open;
    this.input.setAttribute("aria-expanded", String(this.open));
    if (this.open) this.input.setAttribute("aria-activedescendant", `cmd-opt-${this.selected}`);
    else this.input.removeAttribute("aria-activedescendant");
  }
}
