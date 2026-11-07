import { describe, expect, it } from "vitest";
import { parseAuditLog, recentIncidents, summarizeAudit, type AuditEntry } from "./audit.ts";

const line = (entry: Partial<AuditEntry>): string =>
  JSON.stringify({ ts: "2026-11-05T10:00:00.000Z", agent: "claude", tool: "Bash", decision: "deny", rule: "file-deletion", detail: "rm x", ...entry });

describe("parseAuditLog", () => {
  it("reads valid lines and counts the bad ones", () => {
    const text = [line({}), "", "not json", line({ decision: "ask", rule: "unknown-command" }), '{"ts":"x"}'].join("\n");
    const parsed = parseAuditLog(text);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.skipped).toBe(2);
  });

  it("tolerates a torn last line", () => {
    const parsed = parseAuditLog(`${line({})}\n{"ts":"2026-11-05T1`);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
  });

  it("handles an empty log", () => {
    expect(parseAuditLog("")).toEqual({ entries: [], skipped: 0 });
  });
});

describe("summarizeAudit", () => {
  const entries = parseAuditLog(
    [
      line({ ts: "2026-11-05T10:00:00Z" }),
      line({ ts: "2026-11-05T10:01:00Z" }),
      line({ ts: "2026-11-05T10:02:00Z", rule: "git-write", detail: "git push" }),
      line({ ts: "2026-11-05T10:03:00Z", decision: "ask", rule: "unknown-command", agent: "cursor" }),
      line({ ts: "2026-11-05T09:00:00Z", decision: "allow", rule: "user-allowed" }),
    ].join("\n"),
  ).entries;

  it("counts by decision, rule and agent", () => {
    const summary = summarizeAudit(entries);
    expect(summary.total).toBe(5);
    expect(summary.byDecision).toEqual({ allow: 1, ask: 1, deny: 3 });
    expect(summary.byAgent).toEqual({ claude: 4, cursor: 1 });
    expect(summary.byRule[0]).toEqual({ rule: "file-deletion", decision: "deny", count: 2 });
    expect(summary.first).toBe("2026-11-05T09:00:00Z");
    expect(summary.last).toBe("2026-11-05T10:03:00Z");
  });

  it("handles no entries", () => {
    expect(summarizeAudit([])).toMatchObject({ total: 0, first: null, last: null, byRule: [] });
  });

  it("lists recent blocked or asked actions, newest first, without allows", () => {
    const recent = recentIncidents(entries, 3);
    expect(recent.map((entry) => entry.ts)).toEqual(["2026-11-05T10:03:00Z", "2026-11-05T10:02:00Z", "2026-11-05T10:01:00Z"]);
    expect(recent.some((entry) => entry.decision === "allow")).toBe(false);
  });
});
