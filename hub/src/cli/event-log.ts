import type { PiEvent } from "../shared/protocol.js";

export interface LogEntry {
  seq: number;
  event: PiEvent;
  size: number;
}

export interface Replay {
  reset: boolean;
  entries: { seq: number; event: PiEvent }[];
}

export interface EventLogLimits {
  maxEvents: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: EventLogLimits = { maxEvents: 5000, maxBytes: 20 * 1024 * 1024 };

/** Parses PORCUPINE_EVENT_BUFFER as a max event count; falls back to defaults. */
export function limitsFromEnv(value: string | undefined): EventLogLimits {
  const n = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? { ...DEFAULT_LIMITS, maxEvents: n } : DEFAULT_LIMITS;
}

/**
 * Ring buffer of pi events with monotonically increasing seq (first seq is 1).
 * On message_end, the message_update entries since the matching message_start
 * are compacted out; message_end carries the authoritative message.
 */
export class EventLog {
  private entries: LogEntry[] = [];
  private bytes = 0;
  private head = 0;
  private lastMessageStartSeq: number | null = null;

  constructor(private readonly limits: EventLogLimits = DEFAULT_LIMITS) {}

  get headSeq(): number {
    return this.head;
  }

  get oldestSeq(): number {
    return this.entries[0]?.seq ?? this.head + 1;
  }

  get length(): number {
    return this.entries.length;
  }

  append(event: PiEvent): { seq: number; event: PiEvent } {
    const seq = ++this.head;
    const size = Buffer.byteLength(JSON.stringify(event));
    if (event.type === "message_start") this.lastMessageStartSeq = seq;
    if (event.type === "message_end" && this.lastMessageStartSeq !== null) {
      const start = this.lastMessageStartSeq;
      this.entries = this.entries.filter((e) => {
        const drop = e.seq > start && e.event.type === "message_update";
        if (drop) this.bytes -= e.size;
        return !drop;
      });
      this.lastMessageStartSeq = null;
    }
    this.entries.push({ seq, event, size });
    this.bytes += size;
    while (this.entries.length > this.limits.maxEvents || (this.bytes > this.limits.maxBytes && this.entries.length > 1)) {
      const dropped = this.entries.shift();
      if (dropped) this.bytes -= dropped.size;
    }
    return { seq, event };
  }

  /** Events with seq > since. reset is true when since is null, too old, or ahead of head. */
  since(since: number | null): Replay {
    const reset = since === null || since < this.oldestSeq - 1 || since > this.head;
    const from = reset ? 0 : since;
    return {
      reset,
      entries: this.entries.filter((e) => e.seq > from).map(({ seq, event }) => ({ seq, event })),
    };
  }
}
