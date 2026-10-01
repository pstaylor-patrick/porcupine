import { build } from "esbuild";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

function appVersion() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() || "dev";
  } catch {
    return "dev";
  }
}

// Build beside the live dist and swap at the end: the hub serves dist while this
// runs, and a page loaded mid-build must never find its CSS or JS missing.
const OUT = "dist.next";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/icons`, { recursive: true });

const app = await build({
  entryPoints: ["src/app.ts", "src/styles.css"],
  bundle: true,
  format: "esm",
  target: ["es2022", "safari16"],
  outdir: OUT,
  entryNames: "[name]-[hash]",
  minify: true,
  sourcemap: true,
  metafile: true,
  external: ["/fonts/*", "/crayon/*"],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
});

const outputs = Object.keys(app.metafile.outputs).filter((p) => !p.endsWith(".map"));
const js = outputs.find((p) => p.endsWith(".js"));
const css = outputs.find((p) => p.endsWith(".css"));
if (!js || !css) throw new Error("missing bundle outputs");
const jsName = basename(js);
const cssName = basename(css);

const html = readFileSync("src/index.html", "utf8")
  .replace('src="/app.js"', `src="/${jsName}"`)
  .replace('href="/styles.css"', `href="/${cssName}"`);
if (!html.includes(jsName) || !html.includes(cssName)) throw new Error("index.html asset references not rewritten");
writeFileSync(`${OUT}/index.html`, html);

cpSync("src/login.html", `${OUT}/login.html`);
cpSync("src/login.css", `${OUT}/login.css`);
cpSync("src/theme-init.js", `${OUT}/theme-init.js`);
cpSync("src/fonts", `${OUT}/fonts`, { recursive: true });
cpSync("src/crayon", `${OUT}/crayon`, { recursive: true });
const crayon = readdirSync("src/crayon").filter((f) => f.endsWith(".svg")).map((f) => `/crayon/${f}`);
const fonts = readdirSync("src/fonts").filter((f) => f.endsWith(".woff2")).map((f) => `/fonts/${f}`);
cpSync("src/manifest.webmanifest", `${OUT}/manifest.webmanifest`);
for (const f of ["icon-192.png", "icon-512.png", "maskable-512.png", "favicon-32.png"]) copyFileSync(`src/icons/${f}`, `${OUT}/icons/${f}`);
copyFileSync("src/icons/apple-touch-icon-180.png", `${OUT}/apple-touch-icon.png`);
copyFileSync("src/favicon.ico", `${OUT}/favicon.ico`);

const shell = ["/", `/${jsName}`, `/${cssName}`, "/theme-init.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/apple-touch-icon.png", "/icons/favicon-32.png", "/favicon.ico", ...fonts, ...crayon];
await build({
  entryPoints: ["src/sw.ts"],
  bundle: true,
  format: "iife",
  target: ["es2022", "safari16"],
  outfile: `${OUT}/sw.js`,
  minify: true,
  define: {
    __SHELL__: JSON.stringify(shell),
    __VERSION__: JSON.stringify(jsName.replace(/^app-|\.js$/g, "") + "-" + cssName.replace(/^styles-|\.css$/g, "")),
  },
});
// Keep recent older bundles so a page or service worker still on the previous index.html loads.
if (existsSync("dist")) {
  const old = readdirSync("dist")
    .filter((f) => /^(app|styles)-[A-Z0-9]+\.(js|css)$/.test(f) && !existsSync(`${OUT}/${f}`))
    .sort((a, b) => statSync(`dist/${b}`).mtimeMs - statSync(`dist/${a}`).mtimeMs)
    .slice(0, 10);
  for (const f of old) copyFileSync(`dist/${f}`, `${OUT}/${f}`);
}
rmSync("dist.old", { recursive: true, force: true });
if (existsSync("dist")) renameSync("dist", "dist.old");
renameSync(OUT, "dist");
rmSync("dist.old", { recursive: true, force: true });
console.log(`built ${jsName} ${cssName} sw.js`);
