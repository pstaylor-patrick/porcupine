// Renders docs/hero.gif: the lilac crayon scribble draws in, then the logo
// settles in the center and holds. Frames are rendered by index, not wall clock,
// so the output is deterministic.
//
// Run from the repo root (needs ffmpeg on PATH):
//   npx -y -p playwright@1.63.0 node web/scripts/hero-gif.mjs
//
// playwright@1.63.0 uses chromium revision 1243; install it once with
//   npx -y playwright@1.63.0 install chromium
/* global window, document */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = join(root, "docs/hero.gif");

const WIDTH = 480;
const HEIGHT = 240;
const FPS = 15;
const DRAW_FRAMES = 45; // 3s of scribble
const LOGO_FRAMES = 12; // logo fades and scales in
const HOLD_FRAMES = 22; // ~1.5s hold
const TOTAL = DRAW_FRAMES + LOGO_FRAMES + HOLD_FRAMES;
const PLUM = "#24122a";

// `npx -p playwright` puts its node_modules/.bin on PATH but ESM imports do not
// search there, so resolve playwright from those PATH entries.
const binDirs = (process.env.PATH ?? "").split(":").filter((d) => d.endsWith("node_modules/.bin"));
const bases = [process.cwd(), ...binDirs.map((d) => join(d, "..", ".."))];
const require = createRequire(join(root, "noop.js"));
const { chromium } = require(require.resolve("playwright", { paths: bases }));

const scribble = readFileSync(join(root, "web/src/crayon/scribble.svg"), "utf8");
const logo = readFileSync(join(root, "web/src/icons/source/porcupine-1024.png")).toString("base64");

const html = `<!doctype html>
<html><head><style>
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; background: ${PLUM}; overflow: hidden; }
  #scribble svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  #logo { position: absolute; left: 50%; top: 50%; width: 176px; height: 176px;
          border-radius: 36px; transform: translate(-50%, -50%); opacity: 0; }
</style></head><body>
  <div id="scribble">${scribble}</div>
  <img id="logo" src="data:image/png;base64,${logo}" alt="">
  <script>
    const paths = [...document.querySelectorAll("#scribble path")];
    paths.forEach((p) => { p.setAttribute("pathLength", "1"); p.style.strokeDasharray = "1 1"; });
    const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
    window.render = (frame) => {
      const draw = frame / ${DRAW_FRAMES};
      paths.forEach((p, i) => {
        const start = (i / paths.length) * 0.5;
        const local = ease((draw - start) / 0.5);
        p.style.strokeDashoffset = String(1 - local);
      });
      const l = ease((frame - ${DRAW_FRAMES}) / ${LOGO_FRAMES});
      document.getElementById("scribble").style.opacity = String(1 - 0.55 * l);
      const logoEl = document.getElementById("logo");
      logoEl.style.opacity = String(l);
      logoEl.style.transform = "translate(-50%, -50%) scale(" + (0.8 + 0.2 * l) + ")";
    };
  </script>
</body></html>`;

const dir = mkdtempSync(join(tmpdir(), "porcupine-hero-"));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.setContent(html);
  await page.waitForFunction(() => document.getElementById("logo").complete);
  for (let i = 0; i < TOTAL; i++) {
    await page.evaluate((f) => window.render(f), i);
    await page.screenshot({ path: join(dir, `f${String(i).padStart(4, "0")}.png`) });
  }
  await browser.close();

  const input = ["-framerate", String(FPS), "-i", join(dir, "f%04d.png")];
  const palette = join(dir, "palette.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", ...input, "-vf", "palettegen=stats_mode=diff:max_colors=64", palette]);
  execFileSync("ffmpeg", [
    "-v", "error", "-y", ...input, "-i", palette,
    "-lavfi", "paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
    "-loop", "0", out,
  ]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`wrote ${out}: ${TOTAL} frames, ${statSync(out).size} bytes`);
