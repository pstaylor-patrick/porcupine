import { execFile } from "node:child_process";
import { cpus } from "node:os";
import { join } from "node:path";
import { FRAME_INTERVAL_SEC } from "./config.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Runs a binary with an argv array (never a shell). Rejects on non-zero exit or timeout. */
export type Exec = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

export const realExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: opts.timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, shell: false, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr).trim().split("\n").slice(-3).join(" ");
          reject(new Error(`${file} failed: ${err.killed ? "timed out" : (tail || err.message)}`));
        } else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export const PROBE_TIMEOUT_MS = 30_000;
export const PDF_TIMEOUT_MS = 120_000;

/** ffmpeg and whisper time limit: duration * 3 + 300 s. */
export function mediaTimeoutMs(durationSec: number): number {
  return Math.ceil((Math.max(0, durationSec) * 3 + 300) * 1000);
}

export class WhisperMissingError extends Error {
  constructor() {
    super("Audio transcription unavailable: whisper.cpp is not installed. Run ruby install.rb --whisper.");
    this.name = "WhisperMissingError";
  }
}

export interface Tools {
  ffprobeDuration(path: string): Promise<number | null>;
  hasAudioStream(path: string): Promise<boolean>;
  pdfPageCount(path: string): Promise<number>;
  pdfToText(path: string, out: string): Promise<void>;
  pdfPageText(path: string, page: number): Promise<string>;
  renderPdfPage(path: string, page: number, outDir: string): Promise<string>;
  extractAudioWav(path: string, out: string, durationSec: number): Promise<void>;
  sampleFrames(path: string, outDir: string, count: number, durationSec: number): Promise<void>;
  convertImage(path: string, out: string): Promise<void>;
  transcribe(wav: string, outBase: string, whisperBin: string | null, whisperModel: string | null, durationSec: number): Promise<void>;
}

export function makeTools(exec: Exec = realExec, threads: number = Math.max(1, Math.min(4, cpus().length))): Tools {
  const probe = { timeoutMs: PROBE_TIMEOUT_MS };
  const pdf = { timeoutMs: PDF_TIMEOUT_MS };
  return {
    async ffprobeDuration(path) {
      const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], probe);
      const n = Number(stdout.trim());
      return Number.isFinite(n) && n >= 0 ? n : null;
    },
    async hasAudioStream(path) {
      const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path], probe);
      return stdout.trim() !== "";
    },
    async pdfPageCount(path) {
      try {
        const { stdout } = await exec("pdfinfo", [path], probe);
        const m = /^Pages:\s+(\d+)/m.exec(stdout);
        if (m) return Number(m[1]);
      } catch {
        // pdfinfo missing or failed; fall back to counting form feeds.
      }
      const { stdout } = await exec("pdftotext", ["-layout", path, "-"], pdf);
      return Math.max(1, stdout.split("\f").length - 1);
    },
    async pdfToText(path, out) {
      await exec("pdftotext", ["-layout", path, out], pdf);
    },
    async pdfPageText(path, page) {
      const p = String(page);
      const { stdout } = await exec("pdftotext", ["-layout", "-f", p, "-l", p, path, "-"], pdf);
      return stdout;
    },
    async renderPdfPage(path, page, outDir) {
      const p = String(page);
      const prefix = join(outDir, `page-${p.padStart(2, "0")}`);
      await exec("pdftoppm", ["-png", "-r", "110", "-f", p, "-l", p, "-singlefile", path, prefix], pdf);
      return `${prefix}.png`;
    },
    async extractAudioWav(path, out, durationSec) {
      await exec("ffmpeg", ["-nostdin", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out], { timeoutMs: mediaTimeoutMs(durationSec) });
    },
    async sampleFrames(path, outDir, count, durationSec) {
      await exec(
        "ffmpeg",
        ["-nostdin", "-y", "-i", path, "-vf", `fps=1/${FRAME_INTERVAL_SEC},scale='min(1280,iw)':-2`, "-frames:v", String(count), join(outDir, "frame-%04d.png")],
        { timeoutMs: mediaTimeoutMs(durationSec) },
      );
    },
    async convertImage(path, out) {
      await exec("ffmpeg", ["-nostdin", "-y", "-i", path, "-frames:v", "1", out], probe);
    },
    async transcribe(wav, outBase, whisperBin, whisperModel, durationSec) {
      if (!whisperBin || !whisperModel) throw new WhisperMissingError();
      await exec(whisperBin, ["-m", whisperModel, "-f", wav, "-otxt", "-of", outBase, "-t", String(threads), "-l", "auto"], {
        timeoutMs: mediaTimeoutMs(durationSec),
      });
    },
  };
}
