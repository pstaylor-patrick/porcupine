#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultEnvFile, resolveRuntimeDir } from "../shared/paths.js";
import { buildChildEnv, buildPiArgs, parseCliArgs, parseEnvFile, resolveDefaults, resolveName } from "./args.js";
import { limitsFromEnv } from "./event-log.js";
import { createLogger } from "./log.js";
import { readPinnedPiVersion, startSession } from "./session.js";

const ASK_EXTENSION = fileURLToPath(new URL("../extension/ask-user-question.js", import.meta.url));
const AUTOCOMPACT_EXTENSION = fileURLToPath(new URL("../extension/autocompact/index.js", import.meta.url));
const HOOKS_EXTENSION = fileURLToPath(new URL("../extension/claude-hooks/index.js", import.meta.url));
const SKILLS_EXTENSION = fileURLToPath(new URL("../extension/claude-skills/index.js", import.meta.url));

function loadEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  // A dead pane pipe (e.g. `| tee` killed by Ctrl-C) must not crash us before cleanup.
  process.stderr.on("error", () => undefined);
  process.stdout.on("error", () => undefined);
  const log = createLogger();
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    log(`error: ${(e as Error).message}`);
    process.exit(2);
  }
  const cwd = process.cwd();
  const envFile = defaultEnvFile(process.env);
  const childEnv = buildChildEnv(process.env, loadEnvFile(envFile));
  const session = await startSession({
    name: resolveName({ explicit: args.name, env: process.env, cwd }),
    cwd,
    piBin: process.env.PORCUPINE_PI_BIN ?? "pi",
    piArgs: buildPiArgs(args.piArgs, [ASK_EXTENSION, AUTOCOMPACT_EXTENSION, HOOKS_EXTENSION, SKILLS_EXTENSION], resolveDefaults(childEnv)),
    childEnv,
    runtimeDir: resolveRuntimeDir({ env: process.env }),
    log,
    limits: limitsFromEnv(process.env.PORCUPINE_EVENT_BUFFER),
    expectedPiVersion: readPinnedPiVersion(new URL("../../package.json", import.meta.url)),
  }).catch(() => process.exit(1));

  process.on("exit", () => session.cleanup());
  process.on("uncaughtException", (e) => {
    log(`error: ${e.message}`);
    session.cleanup();
    session.pi.kill("SIGTERM");
    process.exit(1);
  });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      log(`received ${sig}, shutting down`);
      void session.shutdown();
    });
  }
  const code = await session.done;
  log(`exit ${code}`);
  process.exit(code);
}

void main();
