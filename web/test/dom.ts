import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Loads the app shell body into the happy-dom document. */
export function loadShell(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "../src/index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
}
