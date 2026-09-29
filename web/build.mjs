import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/app.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: "dist",
  minify: true,
  sourcemap: true,
});
cpSync("src/index.html", "dist/index.html");
