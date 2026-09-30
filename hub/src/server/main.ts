#!/usr/bin/env node
import { ConfigError, loadConfig } from "./config.js";
import { createHub } from "./hub.js";

const stamp = (): string => new Date().toTimeString().slice(0, 8);
const log = (line: string): void => console.log(`${stamp()} ${line}`);

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig({ env: process.env });
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`porcupine-hub: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const hub = createHub({ config, log });
  const { port } = await hub.listen();
  log(`hub listening on http://${config.host}:${port}${config.dev ? " (dev mode)" : ""} runtime=${config.runtimeDir}`);
  const stop = (): void => {
    log("shutting down");
    void hub.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
