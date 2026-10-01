import type { PushMessage } from "./send.js";

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
    void this.send({ title: s.name, body: title ? `Needs input: ${title}` : "Needs input", session: s.id, tag: `input-${s.id}` });
  }

  budget(text: string): void {
    void this.send({ title: "Porcupine budget", body: text, tag: "budget" });
  }
}
