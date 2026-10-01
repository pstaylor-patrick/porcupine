import { ASK_TITLE_PREFIX } from "../extension/ask-user-question.js";
import { HOOK_CONFIRM_PREFIX } from "../extension/claude-hooks/index.js";
import type { PiEvent, PorcupineNotice, PorcupineUiStateEvent } from "../shared/protocol.js";

/** Dialog methods block pi until an extension_ui_response arrives (rpc-extension-ui.md). */
export const DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;
/** Fire-and-forget methods expect no response. */
export const FIRE_AND_FORGET_METHODS = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"] as const;

export interface UiDecision {
  /** Written to pi stdin, if any. */
  response?: { type: "extension_ui_response"; id: string; cancelled: true };
  /** Appended to the event log, if any. */
  event?: PiEvent;
  /** Dialog id now awaiting a browser answer, if forwarded. */
  forward?: string;
  /** Pane log line, if any. */
  log?: string;
}

/**
 * Dialogs go to the browser when one is attached to answer them. With nobody
 * attached they are cancelled, because a dialog blocks pi until answered and
 * startup prompts from extensions would otherwise hang the session. Questions
 * from the ask_user_question tool always wait: the user may reopen the app.
 */
export function handleUiRequest(req: PiEvent, opts: { browserAttached: boolean } = { browserAttached: false }): UiDecision {
  const method = typeof req.method === "string" ? req.method : "unknown";
  const id = typeof req.id === "string" ? req.id : "";
  if (method === "notify") return { event: req };
  const ui = uiStateEvent(req);
  if (ui) return { event: ui as unknown as PiEvent };
  if (method === "setWidget") return { log: "extension UI setWidget dropped: not a string array" };
  if ((FIRE_AND_FORGET_METHODS as readonly string[]).includes(method)) return {};
  const known = (DIALOG_METHODS as readonly string[]).includes(method);
  const title = typeof req.title === "string" ? req.title : "";
  if (known && id && (opts.browserAttached || title.startsWith(ASK_TITLE_PREFIX) || title.startsWith(HOOK_CONFIRM_PREFIX))) {
    return { forward: id, event: req, log: `extension UI ${method} waiting for an answer` };
  }
  const notice: PorcupineNotice = {
    type: "porcupine_notice",
    level: "warn",
    text: `extension UI ${method} auto-cancelled: ${title}`,
  };
  return {
    response: { type: "extension_ui_response", id, cancelled: true },
    event: notice as unknown as PiEvent,
    log: known
      ? `extension UI ${method} auto-cancelled: ${title}`
      : `extension UI unknown method ${method} auto-cancelled: ${title}`,
  };
}

/** Maps setStatus, setWidget (string arrays only) and setTitle to porcupine_ui_* events. */
export function uiStateEvent(req: PiEvent): PorcupineUiStateEvent | null {
  switch (req.method) {
    case "setStatus": {
      if (typeof req.statusKey !== "string") return null;
      const text = typeof req.statusText === "string" ? req.statusText : null;
      return { type: "porcupine_ui_status", key: req.statusKey, text };
    }
    case "setWidget": {
      if (typeof req.widgetKey !== "string") return null;
      const raw = req.widgetLines;
      if (raw === undefined || raw === null) return { type: "porcupine_ui_widget", key: req.widgetKey, lines: null };
      if (!Array.isArray(raw) || !raw.every((l) => typeof l === "string")) return null;
      return { type: "porcupine_ui_widget", key: req.widgetKey, lines: raw as string[] };
    }
    case "setTitle":
      return typeof req.title === "string" ? { type: "porcupine_ui_title", title: req.title } : null;
    default:
      return null;
  }
}

/** Last-known extension UI state, replayed to a client whose event replay was reset. */
export class UiStateStore {
  private readonly status = new Map<string, PiEvent>();
  private readonly widgets = new Map<string, PiEvent>();
  private title: PiEvent | null = null;

  apply(e: PiEvent): void {
    const key = typeof e.key === "string" ? e.key : "";
    if (e.type === "porcupine_ui_status") {
      if (e.text === null) this.status.delete(key);
      else this.status.set(key, e);
    } else if (e.type === "porcupine_ui_widget") {
      if (e.lines === null) this.widgets.delete(key);
      else this.widgets.set(key, e);
    } else if (e.type === "porcupine_ui_title") this.title = e;
  }

  snapshot(): PiEvent[] {
    return [...this.status.values(), ...this.widgets.values(), ...(this.title ? [this.title] : [])];
  }
}
