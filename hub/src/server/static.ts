import { createReadStream, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** Paths reachable without a session cookie. */
export function isPublicPath(path: string): boolean {
  return (
    path === "/login" ||
    path === "/login.css" ||
    path === "/theme-init.js" ||
    path === "/sw.js" ||
    path === "/manifest.webmanifest" ||
    path === "/apple-touch-icon.png" ||
    path === "/favicon.ico" ||
    path.startsWith("/icons/")
  );
}

export function cacheControl(path: string): string {
  if (/-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(path)) return "public, max-age=31536000, immutable";
  return "no-cache";
}

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

/** Resolves a URL path inside root, refusing traversal. Returns null if outside or not a file. */
export function resolveStatic(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const full = normalize(join(root, rel));
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

export function serveStatic(root: string, urlPath: string, res: ServerResponse, method: string): boolean {
  const file = resolveStatic(root, urlPath);
  if (!file) return false;
  res.statusCode = 200;
  res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
  res.setHeader("Cache-Control", cacheControl(file));
  if (method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
  return true;
}
