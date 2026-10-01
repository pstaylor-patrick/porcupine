import { ASK_TITLE_PREFIX } from "../../extension/ask-user-question.js";
import { DEFAULT_PREFS, type NotifyPrefs } from "./prefs.js";
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

/** One push per session per this window; anything in between collapses into a single trailing push. */
export const SESSION_COOLDOWN_MS = 2 * 60 * 1000;

export interface NotifierOptions {
  cooldownMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  prefs?: () => NotifyPrefs;
}

interface Gate {
  lastAt: number;
  lastBody: string;
  pending: PushMessage | null;
  timer: boolean;
}

/**
 * Turns hub activity into push messages. Session events are skipped while a
 * client is viewing that session, and rate limited per session: the first
 * event sends at once, later ones inside the cooldown collapse into one push
 * when it ends (needs-input outranks "finished", repeats are dropped).
 */
export class Notifier {
  private readonly gates = new Map<string, Gate>();
  private readonly cooldown: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly prefs: () => NotifyPrefs;

  constructor(
    private readonly send: (msg: PushMessage) => Promise<void> | void,
    o: NotifierOptions = {},
  ) {
    this.cooldown = o.cooldownMs ?? SESSION_COOLDOWN_MS;
    this.now = o.now ?? Date.now;
    this.prefs = o.prefs ?? (() => DEFAULT_PREFS);
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  }

  settled(s: NotifierSession, viewed: boolean): void {
    if (viewed || !this.prefs().finished) return;
    this.queue(s.id, { title: s.name, body: "Agent finished", session: s.id, tag: `session-${s.id}` }, false);
  }

  needsInput(s: NotifierSession, title: string, viewed: boolean): void {
    if (viewed || !this.prefs().input) return;
    const text = readableTitle(title);
    this.queue(s.id, { title: s.name, body: text ? `Needs input: ${text}` : "Needs input", session: s.id, tag: `session-${s.id}` }, true);
  }

  budget(text: string): void {
    if (!this.prefs().budget) return;
    void this.send({ title: "Porcupine budget", body: text, tag: "budget" });
  }

  private queue(id: string, msg: PushMessage, urgent: boolean): void {
    const now = this.now();
    let g = this.gates.get(id);
    if (!g || now - g.lastAt >= this.cooldown) {
      g = { lastAt: now, lastBody: msg.body, pending: null, timer: false };
      this.gates.set(id, g);
      void this.send(msg);
      return;
    }
    if (msg.body === g.lastBody) return;
    const pendingUrgent = g.pending?.body.startsWith("Needs input") ?? false;
    if (urgent || !pendingUrgent) g.pending = msg;
    if (g.timer) return;
    g.timer = true;
    const gate = g;
    this.setTimer(() => {
      gate.timer = false;
      const next = gate.pending;
      gate.pending = null;
      if (!next || next.body === gate.lastBody) return;
      gate.lastAt = this.now();
      gate.lastBody = next.body;
      void this.send(next);
    }, g.lastAt + this.cooldown - now);
  }
}
