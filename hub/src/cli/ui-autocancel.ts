import { ASK_TITLE_PREFIX } from "../extension/ask-user-question.js";
import type { PiEvent, PorcupineNotice } from "../shared/protocol.js";

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
  if ((FIRE_AND_FORGET_METHODS as readonly string[]).includes(method)) return {};
  const known = (DIALOG_METHODS as readonly string[]).includes(method);
  const title = typeof req.title === "string" ? req.title : "";
  if (known && id && (opts.browserAttached || title.startsWith(ASK_TITLE_PREFIX))) {
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
