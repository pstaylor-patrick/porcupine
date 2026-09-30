import { accessSync, constants, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimeDirInput {
  env: NodeJS.ProcessEnv;
  home?: string;
  isWritable?: (dir: string) => boolean;
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the runtime dir: PORCUPINE_RUNTIME_DIR, else $XDG_RUNTIME_DIR/porcupine, else ~/.porcupine/run. */
export function resolveRuntimeDir(input: RuntimeDirInput): string {
  const { env } = input;
  const override = env.PORCUPINE_RUNTIME_DIR;
  if (override) return override;
  const xdg = env.XDG_RUNTIME_DIR;
  const isWritable = input.isWritable ?? writable;
  if (xdg && isWritable(xdg)) return join(xdg, "porcupine");
  return join(input.home ?? homedir(), ".porcupine", "run");
}

/** Creates the runtime dir with mode 0700 and returns it. */
export function ensureRuntimeDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function sessionPaths(runtimeDir: string, id: string): { sock: string; meta: string } {
  return { sock: join(runtimeDir, `${id}.sock`), meta: join(runtimeDir, `${id}.json`) };
}
