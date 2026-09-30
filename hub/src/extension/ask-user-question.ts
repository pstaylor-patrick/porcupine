/**
 * Pi extension: an ask_user_question tool modelled on Claude Code's.
 *
 * In RPC mode the whole question set travels as one `input` dialog whose
 * title is ASK_TITLE_PREFIX + JSON, so the PWA can show every question in a
 * single sheet and answer with JSON. Pi's RPC dialogs only carry a title and
 * plain strings, so this encoding is how descriptions and multi-select reach
 * the client. In the TUI it falls back to one select per question.
 *
 * Loaded by the porcupine CLI with `pi --extension`; pi resolves nothing from
 * this file, so it carries its own minimal types instead of importing pi's.
 */

/** Keep in sync with web/src/questions.ts. */
export const ASK_TITLE_PREFIX = "porcupine.ask_user_question/1 ";
const OTHER_LABEL = "Other (type an answer)";

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
export interface AskParams {
  questions: AskQuestion[];
}
/** Answers keyed by question text; multi-select answers are joined with ", ". */
export type AskAnswers = Record<string, string>;

interface DialogOptions {
  signal?: AbortSignal | undefined;
}
interface ExtensionContext {
  mode: string;
  ui: {
    select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
    input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
  };
}
interface ToolResult {
  content: { type: "text"; text: string }[];
  details: { questions: AskQuestion[]; answers: AskAnswers | null };
}
interface ExtensionAPI {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    executionMode?: "sequential";
    exposure?: "model-only";
    execute(
      toolCallId: string,
      params: AskParams,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<ToolResult>;
  }): void;
}

const PARAMETERS = {
  type: "object",
  required: ["questions"],
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description: "Questions to ask the user (1-4)",
      items: {
        type: "object",
        required: ["question", "header", "options"],
        additionalProperties: false,
        properties: {
          question: { type: "string", description: "The complete question, ending with a question mark" },
          header: { type: "string", description: "Very short label shown as a chip (max 12 chars)" },
          multiSelect: { type: "boolean", description: "Allow more than one option to be chosen" },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description: "2-4 distinct choices. Do not add an 'Other' option; the user can always type one.",
            items: {
              type: "object",
              required: ["label"],
              additionalProperties: false,
              properties: {
                label: { type: "string", description: "Concise choice, 1-5 words" },
                description: { type: "string", description: "What choosing this means, with tradeoffs" },
              },
            },
          },
        },
      },
    },
  },
} as const;

const DESCRIPTION =
  "Ask the user 1-4 multiple-choice questions when you are blocked on a decision that is genuinely theirs to make. " +
  "The user can also type a free-text answer. If you recommend an option, list it first and end its label with " +
  "' (Recommended)'. Do not use this to ask whether a plan is ready or whether to proceed.";

export function encodeAskTitle(params: AskParams): string {
  return ASK_TITLE_PREFIX + JSON.stringify({ questions: params.questions });
}

/** Parses the PWA's JSON reply, keeping only string answers to questions that were asked. */
export function parseAnswers(raw: string, questions: AskQuestion[]): AskAnswers | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const answers = (data as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== "object") return null;
  const out: AskAnswers = {};
  for (const q of questions) {
    const a = (answers as Record<string, unknown>)[q.question];
    if (typeof a === "string" && a.trim()) out[q.question] = a.trim();
  }
  return out;
}

export function formatResult(questions: AskQuestion[], answers: AskAnswers | null): ToolResult {
  const text = answers
    ? [
        "The user answered:",
        ...questions.map((q) => `- ${q.question} -> ${answers[q.question] ?? "(no answer)"}`),
      ].join("\n")
    : "The user dismissed the questions without answering. Ask in plain text or proceed with your best judgment, and say which you chose.";
  return { content: [{ type: "text", text }], details: { questions, answers } };
}

async function askInTerminal(questions: AskQuestion[], ctx: ExtensionContext, signal?: AbortSignal): Promise<AskAnswers | null> {
  const answers: AskAnswers = {};
  for (const q of questions) {
    const labels = q.options.map((o) => (o.description ? `${o.label}: ${o.description}` : o.label));
    const picked = await ctx.ui.select(q.question, [...labels, OTHER_LABEL], { signal });
    if (picked === undefined) return null;
    const answer =
      picked === OTHER_LABEL
        ? await ctx.ui.input(q.question, "Your answer", { signal })
        : q.options[labels.indexOf(picked)]?.label;
    if (answer === undefined) return null;
    answers[q.question] = answer;
  }
  return answers;
}

export default function askUserQuestion(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    executionMode: "sequential",
    exposure: "model-only",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "rpc") return formatResult(params.questions, await askInTerminal(params.questions, ctx, signal));
      const raw = await ctx.ui.input(encodeAskTitle(params), undefined, { signal });
      return formatResult(params.questions, raw === undefined ? null : parseAnswers(raw, params.questions));
    },
  });
}
