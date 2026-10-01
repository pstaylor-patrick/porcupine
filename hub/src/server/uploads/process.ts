import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { UploadConfig } from "./config.js";
import { frameCount, type Probe } from "./estimate.js";
import type { UploadMeta } from "./store.js";
import { WhisperMissingError, type Tools } from "./tools.js";

export interface ProcessResult {
  id: string;
  kind: UploadMeta["kind"];
  name: string;
  original: string;
  durationSec?: number;
  pages?: number;
  artifacts: { transcript?: string; text?: string; frames?: string[]; pages?: string[] };
  notes: string[];
}


/** Cheap metadata used for the estimate; cached in probe.json. */
export async function probeUpload(dir: string, meta: UploadMeta, tools: Tools): Promise<Probe> {
  const cache = join(dir, "probe.json");
  if (existsSync(cache)) return JSON.parse(await readFile(cache, "utf8")) as Probe;
  const original = join(dir, meta.name);
  let probe: Probe = {};
  if (meta.kind === "audio" || meta.kind === "video") {
    probe = { durationSec: (await tools.ffprobeDuration(original)) ?? 0 };
  } else if (meta.kind === "pdf") {
    const pages = await tools.pdfPageCount(original);
    let textChars = 0;
    let emptyPages = 0;
    for (let p = 1; p <= pages; p++) {
      const t = (await tools.pdfPageText(original, p)).trim();
      textChars += t.length;
      if (t === "") emptyPages++;
    }
    probe = { pages, textChars, emptyPages };
  }
  await writeFile(cache, JSON.stringify(probe) + "\n", { mode: 0o600 });
  return probe;
}

async function pngs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".png")).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

async function transcribeInto(dir: string, original: string, dur: number, cfg: UploadConfig, tools: Tools, r: ProcessResult): Promise<void> {
  if (!cfg.whisperBin || !cfg.whisperModel) throw new WhisperMissingError();
  const wav = join(dir, "whisper-input.wav");
  try {
    await tools.extractAudioWav(original, wav, dur);
    await tools.transcribe(wav, join(dir, "transcript"), cfg.whisperBin, cfg.whisperModel, dur);
  } finally {
    await rm(wav, { force: true });
  }
  const out = join(dir, "transcript.txt");
  if (!existsSync(out)) await writeFile(out, "", { mode: 0o600 });
  r.artifacts.transcript = out;
  if ((await readFile(out, "utf8")).trim() === "") r.notes.push("no speech detected");
}

/** Preprocesses one upload into derived files. Idempotent via result.json. */
export async function processUpload(dir: string, meta: UploadMeta, cfg: UploadConfig, tools: Tools): Promise<ProcessResult> {
  const cached = join(dir, "result.json");
  if (existsSync(cached)) return JSON.parse(await readFile(cached, "utf8")) as ProcessResult;
  const original = join(dir, meta.name);
  const r: ProcessResult = { id: meta.id, kind: meta.kind, name: meta.name, original, artifacts: {}, notes: [] };
  switch (meta.kind) {
    case "audio": {
      const dur = (await tools.ffprobeDuration(original)) ?? 0;
      r.durationSec = dur;
      await transcribeInto(dir, original, dur, cfg, tools, r);
      break;
    }
    case "video": {
      const dur = (await tools.ffprobeDuration(original)) ?? 0;
      r.durationSec = dur;
      const frames = join(dir, "frames");
      await mkdir(frames, { recursive: true, mode: 0o700 });
      await tools.sampleFrames(original, frames, frameCount(dur), dur);
      r.artifacts.frames = await pngs(frames);
      if (!(await tools.hasAudioStream(original))) r.notes.push("no audio track");
      else {
        try {
          await transcribeInto(dir, original, dur, cfg, tools, r);
        } catch (e) {
          if (!(e instanceof WhisperMissingError)) throw e;
          // Frames are still useful; do not cache so a later whisper install is picked up.
          r.notes.push(e.message);
          return r;
        }
      }
      break;
    }
    case "pdf": {
      const pages = await tools.pdfPageCount(original);
      r.pages = pages;
      const text = join(dir, "text.txt");
      await tools.pdfToText(original, text);
      r.artifacts.text = text;
      const out = join(dir, "pages");
      const rendered: string[] = [];
      for (let p = 1; p <= pages; p++) {
        if ((await tools.pdfPageText(original, p)).trim() !== "") continue;
        await mkdir(out, { recursive: true, mode: 0o700 });
        rendered.push(await tools.renderPdfPage(original, p, out));
      }
      if (rendered.length > 0) r.artifacts.pages = rendered;
      break;
    }
    case "image": {
      const ext = extname(meta.name).toLowerCase();
      if (ext === ".heic" || ext === ".heif" || meta.mime === "image/heic" || meta.mime === "image/heif") {
        const png = join(dir, `${meta.name.slice(0, meta.name.length - ext.length) || "image"}.png`);
        try {
          await tools.convertImage(original, png);
          if (!(await stat(png)).size) throw new Error("empty output");
          r.original = png;
          r.notes.push("converted from HEIC to PNG");
        } catch {
          r.notes.push("unsupported image format");
        }
      }
      break;
    }
    case "text":
      break;
    default:
      r.notes.push("not preprocessed; stored as-is");
  }
  await writeFile(cached, JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
  return r;
}
