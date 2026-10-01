import { IMAGE_TOKENS, MAX_FRAMES, FRAME_INTERVAL_SEC, TRANSCRIPT_TOKENS_PER_MIN } from "./config.js";
import type { Kind } from "./kind.js";

export { IMAGE_TOKENS };

export interface Probe {
  durationSec?: number;
  pages?: number;
  /** PDF only: characters of extracted text. */
  textChars?: number;
  /** PDF only: number of pages with no extractable text. */
  emptyPages?: number;
}

export interface Estimate {
  imageCount: number;
  textTokens: number;
  maxDurationSec: number;
}

export function frameCount(durationSec: number): number {
  return Math.min(MAX_FRAMES, Math.max(1, Math.ceil(durationSec / FRAME_INTERVAL_SEC)));
}

/** Pure, pre-processing estimate of model input for one upload. */
export function estimateUpload(meta: { kind: Kind; size: number }, probe: Probe): Estimate {
  const dur = probe.durationSec ?? 0;
  const transcript = Math.ceil(dur / 60) * TRANSCRIPT_TOKENS_PER_MIN;
  switch (meta.kind) {
    case "audio":
      return { imageCount: 0, textTokens: transcript, maxDurationSec: dur };
    case "video":
      return { imageCount: frameCount(dur), textTokens: transcript, maxDurationSec: dur };
    case "pdf":
      return { imageCount: probe.emptyPages ?? 0, textTokens: Math.ceil((probe.textChars ?? 0) / 4), maxDurationSec: 0 };
    case "image":
      return { imageCount: 1, textTokens: 0, maxDurationSec: 0 };
    case "text":
      return { imageCount: 0, textTokens: Math.ceil(meta.size / 4), maxDurationSec: 0 };
    default:
      return { imageCount: 0, textTokens: 0, maxDurationSec: 0 };
  }
}

export function sumEstimates(list: Estimate[]): Estimate {
  return list.reduce(
    (a, e) => ({ imageCount: a.imageCount + e.imageCount, textTokens: a.textTokens + e.textTokens, maxDurationSec: Math.max(a.maxDurationSec, e.maxDurationSec) }),
    { imageCount: 0, textTokens: 0, maxDurationSec: 0 },
  );
}

/** USD at a per-million input price; null when the price is unknown. */
export function estimateUsd(e: Estimate, inputPerMillion: number | undefined): number | null {
  if (!inputPerMillion || inputPerMillion <= 0) return null;
  return ((e.textTokens + e.imageCount * IMAGE_TOKENS) * inputPerMillion) / 1e6;
}

export function needsConfirm(e: Estimate, usd: number | null, cfg: { confirmUsd: number; confirmMinutes: number }): boolean {
  return (usd !== null && usd > cfg.confirmUsd) || e.maxDurationSec > cfg.confirmMinutes * 60;
}
