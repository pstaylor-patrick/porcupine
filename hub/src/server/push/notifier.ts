import { ASK_TITLE_PREFIX } from "../../extension/ask-user-question.js";
import type { PushMessage } from "./send.js";

/** A dialog title as a person would read it: questions asked via the tool show their first question. */
export function readableTitle(title: string): string {
  if (!title.startsWith(ASK_TITLE_PREFIX)) return title;
  try {
    const { questions } = JSON.parse(title.slice(ASK_TITLE_PREFIX.length)) as { questions?: { question?: unknown }[] };
    const first = questions?.[0]?.question;
    if (typeof first !== "string") return "";
    const more = (questions?.length ?? 1) - 1;
    return more > 0 ? `${first} (+${String(more)} more)` : first;
  } catch {
    return "";
  }
}

export interface NotifierSession {
  id: string;
  name: string;
}

/** Turns hub activity into push messages. Session events are skipped while a client is viewing that session. */
export class Notifier {
  constructor(private readonly send: (msg: PushMessage) => Promise<void> | void) {}

  settled(s: NotifierSession, viewed: boolean): void {
    if (viewed) return;
    void this.send({ title: s.name, body: "Agent finished", session: s.id, tag: `settled-${s.id}` });
  }

  needsInput(s: NotifierSession, title: string, viewed: boolean): void {
    if (viewed) return;
    const text = readableTitle(title);
    void this.send({ title: s.name, body: text ? `Needs input: ${text}` : "Needs input", session: s.id, tag: `input-${s.id}` });
  }

  budget(text: string): void {
    void this.send({ title: "Porcupine budget", body: text, tag: "budget" });
  }
}
