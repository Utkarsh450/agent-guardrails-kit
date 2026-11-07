import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AUDIT_FILE, parseAuditLog, recentIncidents, summarizeAudit, type AuditEntry, type AuditSummary } from "./audit.ts";

export interface AuditReport {
  /** False when there is no audit log yet. */
  exists: boolean;
  summary: AuditSummary;
  recent: AuditEntry[];
  /** Lines of the log that could not be read. */
  skipped: number;
  bytes: number;
}

/** Reads the project's audit log and summarizes it. A missing log is not an error. */
export async function loadAuditReport(root: string, limit = 10): Promise<AuditReport> {
  const file = path.join(root, AUDIT_FILE);
  let text: string;
  let bytes: number;
  try {
    text = await readFile(file, "utf8");
    bytes = (await stat(file)).size;
  } catch {
    return { exists: false, summary: summarizeAudit([]), recent: [], skipped: 0, bytes: 0 };
  }
  const parsed = parseAuditLog(text);
  return {
    exists: true,
    summary: summarizeAudit(parsed.entries),
    recent: recentIncidents(parsed.entries, limit),
    skipped: parsed.skipped,
    bytes,
  };
}
