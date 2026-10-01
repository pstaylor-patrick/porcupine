import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { b64u, unb64u, type VapidKeys } from "./crypto.js";

/** ${XDG_CONFIG_HOME:-~/.config}/porcupine/vapid.json */
export function vapidPath(env: NodeJS.ProcessEnv, home: string): string {
  const cfg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(cfg, "porcupine", "vapid.json");
}

function valid(v: unknown): v is VapidKeys {
  if (!v || typeof v !== "object") return false;
  const k = v as Record<string, unknown>;
  return typeof k.publicKey === "string" && unb64u(k.publicKey).length === 65 && typeof k.privateKey === "string" && unb64u(k.privateKey).length === 32;
}

/** Loads the VAPID keys, generating them once (file mode 0600). The private key is never logged. */
export function loadOrCreateVapid(file: string): VapidKeys {
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!valid(parsed)) throw new Error(`invalid VAPID key file ${file}`);
    chmodSync(file, 0o600);
    return parsed;
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error("VAPID key generation failed");
  const keys: VapidKeys = {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])),
    privateKey: jwk.d,
  };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(keys) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return keys;
}
