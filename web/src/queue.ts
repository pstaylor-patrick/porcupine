/** pi's message queue as the composer sees it: pure model plus read-only chip rendering. */
import { parseSentMessage } from "./attachments.js";
import { el } from "./render.js";

export type QueueKind = "steer" | "followUp";
export interface QueueItem {
  kind: QueueKind;
  text: string;
  pending?: boolean;
}
export interface PiQueue {
  steering: string[];
  followUp: string[];
}

export const emptyQueue = (): PiQueue => ({ steering: [], followUp: [] });

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** Reads a queue_update event or clear_queue response data; missing fields become empty. */
export function parseQueue(e: Record<string, unknown>): PiQueue {
  return { steering: strings(e.steering), followUp: strings(e.followUp) };
}

/** Steering first, then followUp, then client-held items marked pending. */
export function itemsFromQueue(q: PiQueue, held: string[]): QueueItem[] {
  return [
    ...q.steering.map((text): QueueItem => ({ kind: "steer", text })),
    ...q.followUp.map((text): QueueItem => ({ kind: "followUp", text })),
    ...held.map((text): QueueItem => ({ kind: "followUp", text, pending: true })),
  ];
}

/**
 * The pi items to re-add after clear_queue, in order, with the item at removeIndex taken out.
 * promote moves that item to the front as a steer (send now). Held items are never requeued.
 */
export function requeuePlan(items: QueueItem[], removeIndex: number, promote = false): QueueItem[] {
  const target = items[removeIndex];
  const rest = items.filter((it, i) => i !== removeIndex && !it.pending);
  if (!promote || !target) return rest;
  return [{ kind: "steer", text: target.text }, ...rest];
}

/** Text for the composer after Stop: cleared steering, then followUp, then the existing draft. */
export function restoreText(cleared: PiQueue, draft: string): string {
  return [...cleared.steering, ...cleared.followUp, draft].filter((s) => s.trim() !== "").join("\n\n");
}

/** Chip body with the attachment block collapsed to file names. */
export function chipLabel(text: string): { body: string; files: string[] } {
  const parsed = parseSentMessage(text);
  return { body: parsed.text.trim(), files: parsed.attachments.map((a) => a.name) };
}

/** The chip a user acted on: its kind, its index within that kind, and the text it showed. */
export interface QueueTarget {
  kind: QueueKind;
  index: number;
  text: string;
}

/** The pi item at items[i] as a target (index counted within its kind), or null for held items. */
export function targetAt(items: QueueItem[], i: number): QueueTarget | null {
  const it = items[i];
  if (!it || it.pending) return null;
  const index = items.slice(0, i).filter((x) => !x.pending && x.kind === it.kind).length;
  return { kind: it.kind, index, text: it.text };
}

export interface RewritePlan {
  /** Items to re-add after clear_queue, in order. */
  next: QueueItem[];
  /** The text taken out of the queue, or null when the target was not found (queue changed). */
  removed: string | null;
}

/**
 * Maps the target onto the cleared queue (index within kind, then first text match in that kind)
 * and returns what to requeue. With no match everything is requeued unchanged.
 */
export function planRewrite(cleared: PiQueue, target: QueueTarget, promote = false): RewritePlan {
  const items = itemsFromQueue(cleared, []);
  const arr = target.kind === "steer" ? cleared.steering : cleared.followUp;
  const within = arr[target.index] === target.text ? target.index : arr.indexOf(target.text);
  if (within < 0) return { next: items, removed: null };
  const offset = target.kind === "steer" ? 0 : cleared.steering.length;
  return { next: requeuePlan(items, offset + within, promote), removed: target.text };
}

export interface ChipActions {
  edit(i: number): void;
  cancel(i: number): void;
  sendNow(i: number): void;
}

function chipButton(label: string, glyph: string, onClick: () => void, disabled: boolean, extra = ""): HTMLButtonElement {
  const b = el("button", { type: "button", class: `queue-action secondary${extra}`, "aria-label": label, title: label }, glyph);
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

/** Renders chips into the container; hides it when the queue is empty. Actions add Edit, Cancel and Send now buttons. */
export function renderQueueChips(container: HTMLElement, items: QueueItem[], actions?: ChipActions, disabled = false): void {
  container.replaceChildren(
    ...items.map((it, i) => {
      const { body, files } = chipLabel(it.text);
      const chip = el("li", { class: "queue-chip", "data-kind": it.kind });
      if (it.kind === "steer") chip.append(el("span", { class: "queue-marker" }, "steer"));
      if (it.pending) {
        chip.dataset.pending = "";
        chip.append(el("span", { class: "queue-marker" }, "waiting for compaction"));
      }
      chip.append(el("span", { class: "queue-body" }, body));
      if (files.length) chip.append(el("span", { class: "queue-files" }, ...files.map((f) => el("span", { class: "queue-file" }, f))));
      if (actions) {
        const bar = el("span", { class: "queue-actions" });
        bar.append(chipButton("Edit", "\u270E", () => actions.edit(i), disabled), chipButton("Cancel", "\u2715", () => actions.cancel(i), disabled));
        if (it.kind !== "steer" && !it.pending) bar.append(chipButton("Send now", "\u2191", () => actions.sendNow(i), disabled));
        chip.append(bar);
      }
      return chip;
    }),
  );
  container.hidden = items.length === 0;
}
