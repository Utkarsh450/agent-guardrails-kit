import { describe, expect, it } from "vitest";
import { parseAuditLog, recentIncidents, summarizeAudit } from "./audit.ts";

const line = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: "2026-11-07T10:00:00.000Z", agent: "claude", tool: "Bash", decision: "ask", rule: "unknown-command", detail: "python x.py", ...extra });

describe("audit entries from watch mode", () => {
  it("reads the watched flag and leaves older entries without one", () => {
    const parsed = parseAuditLog([line({ watched: true }), line()].join("\n"));
    expect(parsed.skipped).toBe(0);
    expect(parsed.entries[0]?.watched).toBe(true);
    expect(parsed.entries[1]?.watched).toBeUndefined();
  });

  it("skips an entry whose watched flag is not true or false", () => {
    const parsed = parseAuditLog(line({ watched: "yes" }));
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.skipped).toBe(1);
  });

  it("counts watched entries in the summary", () => {
    const { entries } = parseAuditLog([line({ watched: true }), line({ watched: true }), line(), line({ decision: "deny", rule: "file-deletion" })].join("\n"));
    const summary = summarizeAudit(entries);
    expect(summary.watched).toBe(2);
    expect(summary.byDecision).toEqual({ allow: 0, ask: 3, deny: 1 });
  });

  it("counts none for a log without watch mode", () => {
    expect(summarizeAudit(parseAuditLog(line()).entries).watched).toBe(0);
  });

  it("keeps watched asks in the recent list so the report can show them", () => {
    const { entries } = parseAuditLog(line({ watched: true }));
    expect(recentIncidents(entries)[0]).toMatchObject({ decision: "ask", watched: true });
  });
});
