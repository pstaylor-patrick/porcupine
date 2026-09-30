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
  /** Pane log line, if any. */
  log?: string;
}

export function handleUiRequest(req: PiEvent): UiDecision {
  const method = typeof req.method === "string" ? req.method : "unknown";
  const id = typeof req.id === "string" ? req.id : "";
  if (method === "notify") return { event: req };
  if ((FIRE_AND_FORGET_METHODS as readonly string[]).includes(method)) return {};
  const known = (DIALOG_METHODS as readonly string[]).includes(method);
  const title = typeof req.title === "string" ? req.title : "";
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
