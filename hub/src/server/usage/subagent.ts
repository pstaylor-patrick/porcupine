/**
 * Child assistant messages from a subagent tool result. The subagent
 * extension keeps each child's messages in its tool details; the hub records
 * their usage in the ledger under the parent session.
 */
type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function subagentMessages(result: unknown): Rec[] {
  if (!isRec(result) || !isRec(result.details) || !Array.isArray(result.details.results)) return [];
  const out: Rec[] = [];
  for (const r of result.details.results) {
    if (!isRec(r) || !Array.isArray(r.messages)) continue;
    for (const m of r.messages) if (isRec(m) && m.role === "assistant") out.push(m);
  }
  return out;
}
