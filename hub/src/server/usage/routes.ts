import type { IncomingMessage, ServerResponse } from "node:http";
import { BudgetError, validateBudgets } from "./budgets.js";
import type { UsageService } from "./service.js";

export interface UsageRouteContext {
  service: UsageService;
  origins: string[];
  authed(req: IncomingMessage): boolean;
  log(line: string): void;
}

const BODY_LIMIT = 16 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body) + "\n");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new BudgetError("body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new BudgetError("invalid JSON");
  }
}

/** Handles /api/usage and /api/budgets; returns false for other paths. */
export async function handleUsage(req: IncomingMessage, res: ServerResponse, ctx: UsageRouteContext): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://hub").pathname;
  if (path !== "/api/usage" && path !== "/api/budgets") return false;
  const method = req.method ?? "GET";
  if (!ctx.authed(req)) {
    req.resume();
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  if (path === "/api/usage" && method === "GET") {
    json(res, 200, await ctx.service.report());
    return true;
  }
  if (path === "/api/budgets" && method === "GET") {
    json(res, 200, { budgets: ctx.service.getBudgets() });
    return true;
  }
  if (path === "/api/budgets" && method === "POST") {
    const origin = req.headers.origin;
    if (!origin || !ctx.origins.includes(origin)) {
      ctx.log(`budgets rejected: bad origin ${origin ?? "(none)"}`);
      req.resume();
      json(res, 403, { error: "forbidden" });
      return true;
    }
    try {
      const body = (await readJson(req)) as { budgets?: unknown } | null;
      const budgets = validateBudgets(body && typeof body === "object" && "budgets" in body ? body.budgets : body);
      ctx.service.setBudgets(budgets);
      json(res, 200, { budgets });
    } catch (e) {
      if (!(e instanceof BudgetError)) ctx.log(`budgets save failed: ${(e as Error).message}`);
      json(res, e instanceof BudgetError ? (e.message === "body too large" ? 413 : 400) : 500, { error: (e as Error).message });
    }
    return true;
  }
  req.resume();
  json(res, 405, { error: "method not allowed" });
  return true;
}
