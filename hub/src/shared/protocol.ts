/** Wire types shared by the CLI, the hub and (later) the browser. */

export const PROTOCOL_VERSION = 1;

export const ALLOWED_PI_COMMANDS = [
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "get_state",
  "get_messages",
  "get_entries",
  "new_session",
  "get_available_models",
  "set_model",
  "set_thinking_level",
  "compact",
  "extension_ui_response",
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

/** The CLI switched provider after a rate limit and re-sent the last prompt. */
export interface PorcupineFailover {
  type: "porcupine_failover";
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  reason: string;
}
