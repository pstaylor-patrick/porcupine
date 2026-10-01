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

/** Renders read-only chips into the container; hides it when the queue is empty. */
export function renderQueueChips(container: HTMLElement, items: QueueItem[]): void {
  container.replaceChildren(
    ...items.map((it) => {
      const { body, files } = chipLabel(it.text);
      const chip = el("li", { class: "queue-chip", "data-kind": it.kind });
      if (it.kind === "steer") chip.append(el("span", { class: "queue-marker" }, "steer"));
      if (it.pending) {
        chip.dataset.pending = "";
        chip.append(el("span", { class: "queue-marker" }, "waiting for compaction"));
      }
      chip.append(el("span", { class: "queue-body" }, body));
      if (files.length) chip.append(el("span", { class: "queue-files" }, ...files.map((f) => el("span", { class: "queue-file" }, f))));
      return chip;
    }),
  );
  container.hidden = items.length === 0;
}
