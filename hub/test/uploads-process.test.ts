import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UploadConfig } from "../src/server/uploads/config.js";
import { processUpload } from "../src/server/uploads/process.js";
import type { UploadMeta } from "../src/server/uploads/store.js";
import { makeTools, mediaTimeoutMs, WhisperMissingError, type Exec } from "../src/server/uploads/tools.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "porcupine-process-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cfg = (whisper: boolean): UploadConfig => ({
  root: dir,
  confirmUsd: 0.5,
  confirmMinutes: 10,
  whisperBin: whisper ? "/w/whisper-cli" : null,
  whisperModel: whisper ? "/w/ggml-base.bin" : null,
});

function meta(kind: UploadMeta["kind"], name: string): UploadMeta {
  writeFileSync(join(dir, name), "x");
  return { id: "11111111-1111-4111-8111-111111111111", sessionId: "s", name, mime: "", size: 1, kind, createdAt: "" };
}

/** Fake exec: records argv and imitates the outputs each tool would write. */
function fake(opts: { duration: number; audio?: boolean; speech?: string; pdfPages?: string[] }) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (file === "ffprobe") {
      if (args.includes("format=duration")) return { stdout: `${opts.duration}\n`, stderr: "" };
      return { stdout: opts.audio === false ? "" : "1\n", stderr: "" };
    }
    if (file === "ffmpeg" && args.includes("-frames:v")) {
      const pattern = args[args.length - 1] ?? "";
      const n = Math.min(Number(args[args.indexOf("-frames:v") + 1]), 3);
      for (let i = 1; i <= n; i++) writeFileSync(pattern.replace("%04d", String(i).padStart(4, "0")), "png");
    }
    if (file.endsWith("whisper-cli")) writeFileSync(`${args[args.indexOf("-of") + 1]}.txt`, opts.speech ?? "");
    if (file === "pdfinfo") return { stdout: `Pages:          ${opts.pdfPages?.length ?? 0}\n`, stderr: "" };
    if (file === "pdftotext") {
      if (args.includes("-f")) return { stdout: opts.pdfPages?.[Number(args[args.indexOf("-f") + 1]) - 1] ?? "", stderr: "" };
      writeFileSync(args[args.length - 1] ?? "", (opts.pdfPages ?? []).join("\f"));
    }
    if (file === "pdftoppm") writeFileSync(`${args[args.length - 1]}.png`, "png");
    return { stdout: "", stderr: "" };
  };
  return { calls, tools: makeTools(exec, 4) };
}

describe("processUpload", () => {
  it("video: exact ffmpeg and whisper argv, frames capped at 60 for 20 min", async () => {
    const { calls, tools } = fake({ duration: 1200, speech: "hello there" });
    const m = meta("video", "demo.mp4");
    const r = await processUpload(dir, m, cfg(true), tools);
    const src = join(dir, "demo.mp4");
    const wav = join(dir, "whisper-input.wav");
    expect(calls.map((c) => c.file)).toEqual(["ffprobe", "ffmpeg", "ffprobe", "ffmpeg", "/w/whisper-cli"]);
    expect(calls[1]?.args).toEqual(["-nostdin", "-y", "-i", src, "-vf", "fps=1/10,scale='min(1280,iw)':-2", "-frames:v", "60", join(dir, "frames", "frame-%04d.png")]);
    expect(calls[3]?.args).toEqual(["-nostdin", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    expect(calls[4]?.args).toEqual(["-m", "/w/ggml-base.bin", "-f", wav, "-otxt", "-of", join(dir, "transcript"), "-t", "4", "-l", "auto"]);
    expect(r.artifacts.frames).toEqual([1, 2, 3].map((i) => join(dir, "frames", `frame-000${i}.png`)));
    expect(r.artifacts.transcript).toBe(join(dir, "transcript.txt"));
    expect(r.notes).toEqual([]);
    expect(existsSync(wav)).toBe(false);
  });

  it("is idempotent through result.json", async () => {
    const { calls, tools } = fake({ duration: 5 });
    const m = meta("audio", "memo.m4a");
    const first = await processUpload(dir, m, cfg(true), tools);
    expect(first.notes).toEqual(["no speech detected"]);
    const n = calls.length;
    expect(await processUpload(dir, m, cfg(true), tools)).toEqual(first);
    expect(calls.length).toBe(n);
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))).toEqual(first);
  });

  it("audio without whisper throws WhisperMissingError with the install hint", async () => {
    const { calls, tools } = fake({ duration: 5 });
    const err = await processUpload(dir, meta("audio", "memo.m4a"), cfg(false), tools).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhisperMissingError);
    expect((err as Error).message).toBe("Audio transcription unavailable: whisper.cpp is not installed. Run ruby install.rb --whisper.");
    expect(calls.some((c) => c.file === "ffmpeg")).toBe(false);
    expect(existsSync(join(dir, "result.json"))).toBe(false);
  });

  it("video without whisper keeps frames and notes the error; without audio notes no audio track", async () => {
    const a = fake({ duration: 15 });
    const r = await processUpload(dir, meta("video", "a.mp4"), cfg(false), a.tools);
    expect(r.artifacts.frames).toHaveLength(2);
    expect(r.notes[0]).toMatch(/whisper\.cpp is not installed/);
    rmSync(join(dir, "frames"), { recursive: true });
    const b = fake({ duration: 15, audio: false });
    const r2 = await processUpload(dir, meta("video", "b.mp4"), cfg(true), b.tools);
    expect(r2.notes).toEqual(["no audio track"]);
    expect(b.calls.some((c) => c.file.endsWith("whisper-cli"))).toBe(false);
  });

  it("pdf: text.txt plus rendered image-only pages", async () => {
    const { calls, tools } = fake({ duration: 0, pdfPages: ["intro", "", "end"] });
    const r = await processUpload(dir, meta("pdf", "spec.pdf"), cfg(true), tools);
    expect(r.pages).toBe(3);
    expect(r.artifacts.text).toBe(join(dir, "text.txt"));
    expect(r.artifacts.pages).toEqual([join(dir, "pages", "page-02.png")]);
    expect(calls.find((c) => c.file === "pdftoppm")?.args).toEqual(["-png", "-r", "110", "-f", "2", "-l", "2", "-singlefile", join(dir, "spec.pdf"), join(dir, "pages", "page-02")]);
  });

  it("text and image pass through; unknown files get a note", async () => {
    const { tools } = fake({ duration: 0 });
    expect((await processUpload(dir, meta("image", "p.png"), cfg(true), tools)).notes).toEqual([]);
    rmSync(join(dir, "result.json"));
    expect((await processUpload(dir, meta("file", "z.bin"), cfg(true), tools)).notes).toEqual(["not preprocessed; stored as-is"]);
  });
});

describe("mediaTimeoutMs", () => {
  it("returns an integer for fractional durations (execFile rejects non-integer timeouts)", () => {
    expect(mediaTimeoutMs(5.0065)).toBe(315_020);
    expect(Number.isInteger(mediaTimeoutMs(1.23456))).toBe(true);
  });
});
