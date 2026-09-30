import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
export const RETENTION_DAYS = 30;
export const FRAME_INTERVAL_SEC = 10;
export const MAX_FRAMES = 60;
export const IMAGE_TOKENS = 1600;
export const TRANSCRIPT_TOKENS_PER_MIN = 200;
export const MAX_UPLOADS_PER_MESSAGE = 10;

const DEFAULT_CONFIRM_USD = 0.5;
const DEFAULT_CONFIRM_MINUTES = 10;

export interface UploadConfig {
  root: string;
  confirmUsd: number;
  confirmMinutes: number;
  whisperBin: string | null;
  whisperModel: string | null;
}

function nonNegative(raw: string | undefined, fallback: number, name: string, log: (l: string) => void): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    log(`${name} is not a non-negative number; using ${fallback}`);
    return fallback;
  }
  return n;
}

function whisperBin(env: NodeJS.ProcessEnv, home: string): string | null {
  if (env.PORCUPINE_WHISPER_BIN) return existsSync(env.PORCUPINE_WHISPER_BIN) ? env.PORCUPINE_WHISPER_BIN : null;
  const local = join(home, ".local", "bin", "whisper-cli");
  return existsSync(local) ? local : null;
}

function whisperModel(env: NodeJS.ProcessEnv, home: string): string | null {
  const raw = env.PORCUPINE_WHISPER_MODEL?.trim() || "base";
  const path = isAbsolute(raw) ? raw : join(home, ".local", "share", "porcupine", "whisper", `ggml-${raw}.bin`);
  return existsSync(path) ? path : null;
}

export function uploadConfig(
  env: NodeJS.ProcessEnv,
  home: string,
  log: (line: string) => void = () => undefined,
): UploadConfig {
  const dataHome = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share");
  return {
    root: join(dataHome, "porcupine", "uploads"),
    confirmUsd: nonNegative(env.PORCUPINE_CONFIRM_USD, DEFAULT_CONFIRM_USD, "PORCUPINE_CONFIRM_USD", log),
    confirmMinutes: nonNegative(env.PORCUPINE_CONFIRM_MINUTES, DEFAULT_CONFIRM_MINUTES, "PORCUPINE_CONFIRM_MINUTES", log),
    whisperBin: whisperBin(env, home),
    whisperModel: whisperModel(env, home),
  };
}
