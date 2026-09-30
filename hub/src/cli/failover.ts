import type { PiCommand, PiEvent, PiResponse, PorcupineFailover, PorcupineNotice } from "../shared/protocol.js";
import { PROVIDERS } from "./args.js";

/** Env var that carries each provider's key in the pi child env. */
const PROVIDER_KEYS: Readonly<Record<string, string>> = {
  openrouter: "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
};

export interface ModelRef {
  provider: string;
  model: string;
}

export function isRateLimit(text: unknown): boolean {
  return typeof text === "string" && /429|rate[ _]limit|too many requests/i.test(text);
}

/** The other known provider whose key is present in the child env, or null. */
export function otherProvider(current: string, env: NodeJS.ProcessEnv): string | null {
  for (const p of Object.keys(PROVIDERS)) {
    const key = PROVIDER_KEYS[p];
    if (p !== current && key && env[key]) return p;
  }
  return null;
}

export interface FailoverDeps {
  send: (cmd: PiCommand) => Promise<PiResponse>;
  publish: (event: PiEvent) => void;
  log: (line: string) => void;
  env: NodeJS.ProcessEnv;
  current: () => ModelRef | null;
  setCurrent: (m: ModelRef) => void;
}

/** Switches to the same model id on the other provider after pi gives up on a rate limit. One switch per prompt. */
export class Failover {
  private lastPrompt: PiCommand | null = null;
  private failedOverThisPrompt = false;
  private pendingReason: string | null = null;

  constructor(private readonly d: FailoverDeps) {}

  /** Call for every command forwarded to pi. */
  onCommand(cmd: PiCommand): void {
    if (cmd.type !== "prompt") return;
    this.lastPrompt = { type: "prompt", message: cmd.message, ...(cmd.images !== undefined ? { images: cmd.images } : {}) };
    this.failedOverThisPrompt = false;
    this.pendingReason = null;
  }

  /** Call with each forwarded command's response; tracks set_model changes made elsewhere. */
  onResult(cmd: PiCommand, r: PiResponse): void {
    if (cmd.type !== "set_model" || !r.success) return;
    if (typeof cmd.provider === "string" && typeof cmd.modelId === "string") {
      this.d.setCurrent({ provider: cmd.provider, model: cmd.modelId });
    }
  }

  /** Call for every pi event. Resolves once any failover it started is done. */
  async onEvent(e: PiEvent): Promise<void> {
    if (e.type === "auto_retry_end" && e.success !== true && isRateLimit(e.finalError)) {
      this.pendingReason = String(e.finalError);
    } else if (e.type === "message_end") {
      const m = e.message as { role?: string; stopReason?: string; errorMessage?: unknown } | undefined;
      if (m?.role === "assistant" && m.stopReason === "error" && isRateLimit(m.errorMessage)) {
        this.pendingReason = String(m.errorMessage);
      }
    } else if (e.type === "agent_settled") {
      const reason = this.pendingReason;
      this.pendingReason = null;
      if (reason !== null) await this.failover(reason);
    }
  }

  private async failover(reason: string): Promise<void> {
    const from = this.d.current();
    const prompt = this.lastPrompt;
    if (this.failedOverThisPrompt || !from || !prompt) return;
    const other = otherProvider(from.provider, this.d.env);
    if (!other) return;
    this.failedOverThisPrompt = true;
    const to: ModelRef = { provider: other, model: from.model };
    const r = await this.d.send({ type: "set_model", provider: to.provider, modelId: to.model });
    if (!r.success) {
      const notice: PorcupineNotice = {
        type: "porcupine_notice",
        level: "warn",
        text: `failover to ${PROVIDERS[other] ?? other} failed: ${r.error ?? "unknown error"}`,
      };
      this.d.publish(notice as unknown as PiEvent);
      this.d.log(`failover to ${other} failed: ${r.error ?? "unknown"}`);
      return;
    }
    this.d.setCurrent(to);
    const ev: PorcupineFailover = { type: "porcupine_failover", from, to, reason };
    this.d.publish(ev as unknown as PiEvent);
    this.d.log(`failover ${from.provider}/${from.model} -> ${to.provider}/${to.model}`);
    await this.d.send(prompt);
  }
}
