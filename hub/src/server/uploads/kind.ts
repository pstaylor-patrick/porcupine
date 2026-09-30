import { extname } from "node:path";

export type Kind = "image" | "pdf" | "audio" | "video" | "text" | "file";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/heic", "image/heif"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif"]);
const AUDIO_EXT = new Set([".m4a", ".mp3", ".wav", ".ogg", ".opus", ".aac", ".flac", ".amr", ".caf"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);
const TEXT_EXT = new Set([".txt", ".md", ".json", ".csv", ".tsv", ".yaml", ".yml", ".xml", ".log", ".html", ".ts", ".js", ".py", ".rb"]);
const TEXT_MIME = new Set(["application/json", "application/xml", "application/yaml"]);

/** Classifies an upload by MIME type first, then by file extension. */
export function classify(name: string, mime: string): Kind {
  const m = mime.toLowerCase().split(";")[0]?.trim() ?? "";
  const ext = extname(name).toLowerCase();
  if (IMAGE_MIME.has(m) || IMAGE_EXT.has(ext)) return "image";
  if (m === "application/pdf" || ext === ".pdf") return "pdf";
  if (m.startsWith("audio/") || AUDIO_EXT.has(ext)) return "audio";
  if (m.startsWith("video/") || VIDEO_EXT.has(ext)) return "video";
  if (m.startsWith("text/") || TEXT_MIME.has(m) || TEXT_EXT.has(ext)) return "text";
  return "file";
}
