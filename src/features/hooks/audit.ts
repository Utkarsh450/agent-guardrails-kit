import { z } from "zod";
import { STATE_DIR } from "./approval.ts";

/**
 * Reads the audit log the guard writes (one JSON object per line) and summarizes it.
 * The log stays on the user's machine in a gitignored folder and is never sent anywhere.
 */

export const AUDIT_FILE = `${STATE_DIR}/audit.log`;
/** The guard stops writing at this size and never deletes or rotates (a no-deletion rule). */
export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;

const entrySchema = z.object({
  ts: z.string(),
  agent: z.string(),
  tool: z.string(),
  decision: z.enum(["allow", "ask", "deny"]),
  rule: z.string(),
  detail: z.string().default(""),
  /** True when watch mode let an action through that would normally have asked. */
  watched: z.boolean().optional(),
});

export type AuditEntry = z.infer<typeof entrySchema>;

export interface ParsedAudit {
  entries: AuditEntry[];
  /** Lines that were not valid entries (a torn write, a hand edit). */
  skipped: number;
}

export function parseAuditLog(text: string): ParsedAudit {
  const entries: AuditEntry[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const result = entrySchema.safeParse(JSON.parse(line));
      if (result.success) entries.push(result.data);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

export interface AuditSummary {
  total: number;
  byDecision: Record<"allow" | "ask" | "deny", number>;
  /** Rules ordered by how often they fired, most first. */
  byRule: Array<{ rule: string; decision: AuditEntry["decision"]; count: number }>;
  byAgent: Record<string, number>;
  /** Asks that watch mode let through. */
  watched: number;
  first: string | null;
  last: string | null;
}

export function summarizeAudit(entries: readonly AuditEntry[]): AuditSummary {
  const byDecision = { allow: 0, ask: 0, deny: 0 };
  const byAgent: Record<string, number> = {};
  const rules = new Map<string, { rule: string; decision: AuditEntry["decision"]; count: number }>();

  let watched = 0;
  for (const entry of entries) {
    if (entry.watched) watched += 1;
    byDecision[entry.decision] += 1;
    byAgent[entry.agent] = (byAgent[entry.agent] ?? 0) + 1;
    const key = `${entry.decision}:${entry.rule}`;
    const row = rules.get(key) ?? { rule: entry.rule, decision: entry.decision, count: 0 };
    row.count += 1;
    rules.set(key, row);
  }

  const byRule = [...rules.values()].sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
  const times = entries.map((entry) => entry.ts).sort();
  return {
    total: entries.length,
    byDecision,
    byRule,
    byAgent,
    watched,
    first: times[0] ?? null,
    last: times[times.length - 1] ?? null,
  };
}

/** Most recent blocked or asked actions first, for a quick "what did the agent try?" view. */
export function recentIncidents(entries: readonly AuditEntry[], limit = 10): AuditEntry[] {
  return entries
    .filter((entry) => entry.decision !== "allow")
    .slice()
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit);
}
