/** Maps pi tool calls and results to Claude Code hook field names. */

type Rec = Record<string, unknown>;

const TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
  ask_user_question: "AskUserQuestion",
  subagent: "Agent",
};

/** Claude Code tool name for a pi tool; unknown tools keep their pi name. */
export function claudeToolName(piName: string): string {
  return TOOL_NAMES[piName] ?? piName;
}

/** Renames pi input fields to Claude Code's (path -> file_path, edits[0] -> old_string/new_string). */
export function claudeToolInput(piName: string, input: Rec): Rec {
  const out: Rec = { ...input };
  if ((piName === "read" || piName === "write" || piName === "edit") && typeof input.path === "string") {
    delete out.path;
    out.file_path = input.path;
  }
  if (piName === "edit" && Array.isArray(input.edits)) {
    const first = input.edits[0] as Rec | undefined;
    if (first && typeof first.oldText === "string") out.old_string = first.oldText;
    if (first && typeof first.newText === "string") out.new_string = first.newText;
    if (input.edits.length > 1) out.replace_all = false;
  }
  return out;
}

/** The tool_response a PostToolUse hook sees. ask_user_question passes its details through, as cf's recorder expects. */
export function claudeToolResponse(piName: string, content: unknown, details: unknown, isError: boolean): unknown {
  if (piName === "ask_user_question" && details && typeof details === "object") return details;
  const text = Array.isArray(content)
    ? content
        .map((c: unknown) => (c && typeof c === "object" && (c as Rec).type === "text" ? String((c as Rec).text ?? "") : ""))
        .join("")
    : "";
  if (piName === "bash") return { stdout: text, stderr: "", interrupted: false, isError };
  return { output: text, isError };
}

/** SessionStart "source" from pi's session_start reason. */
export function sessionSource(reason: unknown): string {
  switch (reason) {
    case "resume":
    case "fork":
      return "resume";
    case "new":
      return "clear";
    default:
      return "startup";
  }
}
