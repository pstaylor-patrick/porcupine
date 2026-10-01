/** Composer attachments: classification, chips, the spend confirm card and the send flow. */
import type { ModelInfo } from "./models.js";

export type Kind = "image" | "pdf" | "audio" | "video" | "text" | "file";

export const MAX_ATTACHMENTS = 10;
export const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
/** Matches the hub's IMAGE_TOKENS. */
export const IMAGE_TOKENS = 1600;

export interface Pending {
  file: File;
  kind: Kind;
  warn?: string | undefined;
  /** Upload progress text shown in the chip, e.g. "uploading 40%". */
  progress?: string | undefined;
}

export interface UploadsConfig {
  confirmUsd: number;
  confirmMinutes: number;
  whisper: boolean;
  maxBytes: number;
}

export interface Estimate {
  imageCount: number;
  textTokens: number;
  maxDurationSec: number;
}

export interface UploadInfo {
  id: string;
  kind: Kind;
  name: string;
  size: number;
  path: string;
  probe: { durationSec?: number; pages?: number };
}

export interface ProcessResult {
  id: string;
  kind: Kind;
  name: string;
  original?: string;
  durationSec?: number | undefined;
  pages?: number | undefined;
  artifacts?: { transcript?: string; text?: string; frames?: string[]; pages?: string[] };
  notes?: string[];
  error?: string;
}

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/heic", "image/heif"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif"]);
const AUDIO_EXT = new Set([".m4a", ".mp3", ".wav", ".ogg", ".opus", ".aac", ".flac", ".amr", ".caf"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);
const TEXT_EXT = new Set([".txt", ".md", ".json", ".csv", ".tsv", ".yaml", ".yml", ".xml", ".log", ".html", ".ts", ".js", ".py", ".rb"]);
const TEXT_MIME = new Set(["application/json", "application/xml", "application/yaml"]);

function extname(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

/** Same table as the hub's kind.ts: MIME type first, then extension. */
export function classify(file: { name: string; type: string }): Kind {
  const m = file.type.toLowerCase().split(";")[0]?.trim() ?? "";
  const ext = extname(file.name);
  if (IMAGE_MIME.has(m) || IMAGE_EXT.has(ext)) return "image";
  if (m === "application/pdf" || ext === ".pdf") return "pdf";
  if (m.startsWith("audio/") || AUDIO_EXT.has(ext)) return "audio";
  if (m.startsWith("video/") || VIDEO_EXT.has(ext)) return "video";
  if (m.startsWith("text/") || TEXT_MIME.has(m) || TEXT_EXT.has(ext)) return "text";
  return "file";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m${String(r).padStart(2, "0")}s` : `${m}m${String(r).padStart(2, "0")}s`;
}

export const NO_VISION_WARNING = "This model cannot see images; frames and scanned pages will be skipped";
export const NO_WHISPER_WARNING = "Needs whisper.cpp for transcription";

/** The warning a chip shows, or undefined. Size beats capability warnings. */
export function chipWarning(
  kind: Kind,
  model: Pick<ModelInfo, "input"> | null,
  size = 0,
  maxBytes = DEFAULT_MAX_BYTES,
  whisper = true,
): string | undefined {
  if (size > maxBytes) return `Too large (max ${formatBytes(maxBytes)})`;
  if ((kind === "audio" || kind === "video") && !whisper) return NO_WHISPER_WARNING;
  if ((kind === "image" || kind === "video" || kind === "pdf") && model && !model.input?.includes("image")) return NO_VISION_WARNING;
  return undefined;
}

/** USD at the model's input price; null when the price is unknown. */
export function estimateUsd(est: Estimate, model: Pick<ModelInfo, "cost"> | null): number | null {
  const price = model?.cost?.input;
  if (price === undefined || price <= 0) return null;
  return ((est.textTokens + est.imageCount * IMAGE_TOKENS) * price) / 1e6;
}

/** True when the cost or length rule trips. An unknown cost only checks length. */
export function needsConfirm(est: Estimate, usd: number | null, cfg: Pick<UploadsConfig, "confirmUsd" | "confirmMinutes">): boolean {
  return (usd !== null && usd > cfg.confirmUsd) || est.maxDurationSec > cfg.confirmMinutes * 60;
}

function describe(r: ProcessResult): string {
  const bits: string[] = [r.kind];
  if (r.durationSec !== undefined && (r.kind === "audio" || r.kind === "video")) bits.push(formatDuration(r.durationSec));
  if (r.pages !== undefined && r.kind === "pdf") bits.push(`${r.pages} page${r.pages === 1 ? "" : "s"}`);
  return bits.join(", ");
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i + 1) : path;
}

function resultLine(r: ProcessResult): string {
  if (r.error) return `- ${r.name}: could not be processed (${r.error})`;
  const a = r.artifacts ?? {};
  const parts: string[] = [];
  if (a.transcript) parts.push(`transcript ${a.transcript}`);
  if (a.text) parts.push(`text ${a.text}`);
  if (a.frames && a.frames.length > 0) {
    const first = a.frames[0] ?? "";
    const name = first.slice(first.lastIndexOf("/") + 1);
    parts.push(`${a.frames.length} frame${a.frames.length === 1 ? "" : "s"} in ${dirOf(first)} (${name} is t=0s, one every 10s)`);
  }
  if (a.pages && a.pages.length > 0) parts.push(`image-only pages rendered: ${a.pages.join(", ")}`);
  if (parts.length === 0 && r.original) parts.push(r.original);
  for (const n of r.notes ?? []) parts.push(`note: ${n}`);
  const head = `- ${r.name} (${describe(r)})`;
  return parts.length > 0 ? `${head}: ${parts.join("; ")}` : head;
}

export const ATTACH_HEADER = "[Attachments, saved on this host. Use the read tool to open them.]";

/** The user's message plus the attachment block pi reads. */
export function buildAttachmentBlock(message: string, results: ProcessResult[]): string {
  if (results.length === 0) return message;
  return `${message}\n\n${ATTACH_HEADER}\n${results.map(resultLine).join("\n")}`;
}

const KIND_ICON: Record<Kind, string> = { image: "IMG", pdf: "PDF", audio: "AUD", video: "VID", text: "TXT", file: "FILE" };

/** Renders chips with createElement only. */
export function renderChips(container: HTMLElement, pending: readonly Pending[], onRemove: (index: number) => void, disabled = false): void {
  container.replaceChildren(
    ...pending.map((p, i) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.dataset.kind = p.kind;
      if (p.warn) chip.dataset.warn = "true";
      const icon = document.createElement("span");
      icon.className = "chip-kind";
      icon.textContent = KIND_ICON[p.kind];
      icon.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "chip-name";
      name.textContent = p.file.name;
      name.title = p.file.name;
      const meta = document.createElement("span");
      meta.className = "chip-meta";
      meta.textContent = p.progress ?? formatBytes(p.file.size);
      chip.append(icon, name, meta);
      if (p.warn) {
        const w = document.createElement("span");
        w.className = "chip-warn";
        w.textContent = p.warn;
        chip.append(w);
      }
      const x = document.createElement("button");
      x.type = "button";
      x.className = "chip-remove";
      x.textContent = "✕";
      x.setAttribute("aria-label", `Remove ${p.file.name}`);
      x.disabled = disabled;
      x.addEventListener("click", () => onRemove(i));
      chip.append(x);
      return chip;
    }),
  );
  container.hidden = pending.length === 0;
}

export interface Breakdown {
  usd: number | null;
  durationSec: number;
  frames: number;
  pages: number;
}

function money(usd: number): string {
  return usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2);
}

export function confirmText(b: Breakdown): string {
  const cost = b.usd === null ? "an unknown amount (no price for this model)" : `about $${money(b.usd)}`;
  const min = Math.round((b.durationSec / 60) * 10) / 10;
  return `This will cost ${cost} and process ${min} min of media (${b.frames} frames, ${b.pages} pages).`;
}

/** Two-step confirm card. Resolves true only after Continue and then Spend. */
export function renderConfirm(card: HTMLElement, b: Breakdown): Promise<boolean> {
  return new Promise((resolve) => {
    const title = document.createElement("p");
    title.id = "attach-confirm-title";
    title.className = "attach-confirm-title";
    title.textContent = confirmText(b);
    const actions = document.createElement("div");
    actions.className = "attach-confirm-actions";
    const done = (ok: boolean) => {
      card.replaceChildren();
      card.hidden = true;
      resolve(ok);
    };
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => done(false));
    const cont = document.createElement("button");
    cont.type = "button";
    cont.className = "primary";
    cont.textContent = "Continue";
    cont.dataset.step = "1";
    cont.addEventListener("click", () => {
      const spend = document.createElement("button");
      spend.type = "button";
      spend.className = "danger";
      spend.dataset.step = "2";
      spend.textContent = b.usd === null ? "Spend (cost unknown)" : `Spend ~$${money(b.usd)}`;
      spend.addEventListener("click", () => done(true));
      actions.replaceChildren(cancel, spend);
      spend.focus();
    });
    actions.append(cancel, cont);
    card.replaceChildren(title, actions);
    card.hidden = false;
    cont.focus();
  });
}

// ---- network --------------------------------------------------------------

export interface Http {
  getConfig(): Promise<UploadsConfig>;
  upload(session: string, file: File, onProgress: (pct: number) => void): Promise<UploadInfo>;
  estimate(session: string, ids: string[]): Promise<{ uploads: (Estimate & { id: string; pages?: number })[]; total: Estimate }>;
  process(session: string, ids: string[]): Promise<{ results: ProcessResult[] }>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

export const http: Http = {
  async getConfig() {
    const r = await fetch("/api/uploads/config", { credentials: "same-origin" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as UploadsConfig;
  },
  upload(session, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const q = new URLSearchParams({ session, name: file.name });
      xhr.open("POST", `/api/uploads?${q.toString()}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener("load", () => {
        let data: unknown = null;
        try {
          data = JSON.parse(xhr.responseText) as unknown;
        } catch {
          /* non-JSON body */
        }
        if (xhr.status === 201 && data) resolve(data as UploadInfo);
        else reject(new Error(((data as { error?: string } | null)?.error ?? `HTTP ${xhr.status}`) + `: ${file.name}`));
      });
      xhr.addEventListener("error", () => reject(new Error(`upload failed, retry: ${file.name}`)));
      xhr.addEventListener("abort", () => reject(new Error(`upload aborted: ${file.name}`)));
      xhr.send(file);
    });
  },
  estimate: (session, ids) => postJson("/api/uploads/estimate", { session, ids }),
  process: (session, ids) => postJson("/api/uploads/process", { session, ids }),
};

export interface SendContext {
  session: string;
  message: string;
  pending: Pending[];
  model: ModelInfo | null;
  http: Http;
  config: UploadsConfig;
  /** Re-renders chips (progress text changes). */
  rerender(): void;
  status(text: string): void;
  confirm(b: Breakdown): Promise<boolean>;
}

/** Uploads, estimates, optionally confirms, processes. Returns the final message text, or null when cancelled. */
export async function sendWithAttachments(ctx: SendContext): Promise<string | null> {
  const uploads: UploadInfo[] = [];
  for (const p of ctx.pending) {
    p.progress = "uploading 0%";
    ctx.rerender();
    try {
      uploads.push(
        await ctx.http.upload(ctx.session, p.file, (pct) => {
          p.progress = `uploading ${pct}%`;
          ctx.rerender();
        }),
      );
      p.progress = "uploaded";
    } catch (e) {
      p.progress = undefined;
      throw e;
    } finally {
      ctx.rerender();
    }
  }
  const ids = uploads.map((u) => u.id);
  ctx.status("Estimating attachments");
  const est = await ctx.http.estimate(ctx.session, ids);
  const usd = estimateUsd(est.total, ctx.model);
  if (needsConfirm(est.total, usd, ctx.config)) {
    const frames = est.uploads.filter((u) => uploads.find((x) => x.id === u.id)?.kind === "video").reduce((n, u) => n + u.imageCount, 0);
    const pages = est.uploads.filter((u) => uploads.find((x) => x.id === u.id)?.kind === "pdf").reduce((n, u) => n + (u.pages ?? 0), 0);
    ctx.status("");
    const ok = await ctx.confirm({ usd, durationSec: est.total.maxDurationSec, frames, pages });
    if (!ok) {
      for (const p of ctx.pending) p.progress = undefined;
      ctx.rerender();
      return null;
    }
  }
  ctx.status("Processing attachments (this can take a while for long media)");
  const { results } = await ctx.http.process(ctx.session, ids);
  ctx.status("");
  const byId = new Map(uploads.map((u) => [u.id, u]));
  const merged = results.map((r) => {
    const u = byId.get(r.id);
    return { ...r, durationSec: r.durationSec ?? u?.probe.durationSec, pages: r.pages ?? u?.probe.pages };
  });
  return buildAttachmentBlock(ctx.message, merged);
}
