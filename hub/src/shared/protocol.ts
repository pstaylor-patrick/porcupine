/** Wire types shared by the CLI, the hub and (later) the browser. */

export const PROTOCOL_VERSION = 1;

export const ALLOWED_PI_COMMANDS = [
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "clear_queue",
  "get_state",
  "get_messages",
  "get_entries",
  "new_session",
  "get_available_models",
  "set_model",
  "set_thinking_level",
  "compact",
  "extension_ui_response",
  "get_session_stats",
  "set_auto_compaction",
  "get_commands",
  "fork",
  "clone",
  "switch_session",
  "get_tree",
  "set_session_name",
  "abort_retry",
] as const;

export type AllowedPiCommand = (typeof ALLOWED_PI_COMMANDS)[number];

export function isAllowedCommand(type: unknown): type is AllowedPiCommand {
  return typeof type === "string" && (ALLOWED_PI_COMMANDS as readonly string[]).includes(type);
}

export type PiEvent = { type: string } & Record<string, unknown>;

export interface PiCommand {
  type: string;
  [key: string]: unknown;
}

export interface PiResponse {
  type?: "response";
  id?: string;
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface SessionMeta {
  id: string;
  name: string;
  cwd: string;
  pid: number;
  piPid: number;
  startedAt: string;
  piVersion: string | null;
  provider: string | null;
  model: string | null;
}

// Hub -> CLI
export interface HelloFrame {
  t: "hello";
  proto: number;
  since: number | null;
}
export interface CmdFrame {
  t: "cmd";
  cid: string;
  cmd: PiCommand;
}
export type HubToCliFrame = HelloFrame | CmdFrame;

// CLI -> Hub
export interface WelcomeFrame {
  t: "welcome";
  proto: number;
  meta: SessionMeta;
  headSeq: number;
  oldestSeq: number;
}
export interface ResetFrame {
  t: "reset";
}
export interface EventFrame {
  t: "event";
  seq: number;
  event: PiEvent;
}
export interface ResultFrame {
  t: "result";
  cid: string;
  response: PiResponse;
}
export interface SessionEndedFrame {
  t: "session_ended";
  code: number;
}
export interface ErrorFrame {
  t: "error";
  message: string;
}
export type CliToHubFrame = WelcomeFrame | ResetFrame | EventFrame | ResultFrame | SessionEndedFrame | ErrorFrame;

/** Sent after a forwarded dialog is answered, so every attached browser closes it. */
export interface PorcupineUiResolved {
  type: "porcupine_ui_resolved";
  id: string;
}

export interface PorcupineNotice {
  type: "porcupine_notice";
  level: "info" | "warn" | "error";
  text: string;
}


/** Extension setStatus, forwarded; text null clears the key. */
export interface PorcupineUiStatus {
  type: "porcupine_ui_status";
  key: string;
  text: string | null;
}

/** Extension setWidget (string lines only), forwarded; lines null clears the key. */
export interface PorcupineUiWidget {
  type: "porcupine_ui_widget";
  key: string;
  lines: string[] | null;
}

/** Extension setTitle, forwarded. */
export interface PorcupineUiTitle {
  type: "porcupine_ui_title";
  title: string;
}

export type PorcupineUiStateEvent = PorcupineUiStatus | PorcupineUiWidget | PorcupineUiTitle;

/** Last-known UI state, sent once after a replay reset. */
export interface PorcupineUiSnapshot {
  type: "porcupine_ui_snapshot";
  events: PiEvent[];
}
