import { AUDIT_FILE, AUDIT_MAX_BYTES, loadAuditReport } from "../hooks/index.ts";
import { ruleInfo } from "../explain/index.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";

export interface ReportOptions {
  /** How many recent blocked or asked actions to list. */
  limit?: number;
  json?: boolean;
}

function shorten(text: string, max: number): string {
  const one = text.replaceAll("\n", " ");
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** `agent-guardrails report`: what the agents tried, from the local audit log. Nothing here ever leaves your machine. */
export async function runReport(ctx: CommandContext, options: ReportOptions = {}): Promise<number> {
  const { ui } = ctx;
  const root = findProjectRoot(ctx.cwd);
  const report = await loadAuditReport(root, options.limit ?? 10);

  if (!report.exists) {
    if (options.json) ui.print(JSON.stringify({ entries: 0 }));
    else ui.info(`No audit log yet (${AUDIT_FILE}). The guard creates it the first time it blocks or asks about something.`);
    return 0;
  }
  const { summary, recent, skipped, bytes: size } = report;

  if (options.json) {
    ui.print(JSON.stringify({ summary, recent, skipped, bytes: size }, null, 2));
    return 0;
  }

  if (summary.total === 0) {
    ui.info("The audit log is empty.");
    return 0;
  }
  ui.print(`${summary.total} recorded action(s) from ${summary.first} to ${summary.last}`);
  ui.print(`  blocked: ${summary.byDecision.deny}   asked: ${summary.byDecision.ask}   allowed: ${summary.byDecision.allow}${summary.byDecision.allow === 0 ? " (allowed actions are only logged when auditAllowed is on)" : ""}`);
  ui.print(`  by agent: ${Object.entries(summary.byAgent).map(([agent, n]) => `${agent} ${n}`).join(", ")}`);

  ui.print("\nMost common reasons");
  for (const row of summary.byRule.slice(0, 8)) {
    ui.print(`  ${String(row.count).padStart(4)}  ${row.decision === "deny" ? "blocked" : row.decision === "ask" ? "asked  " : "allowed"}  ${ruleInfo(row.rule)?.title ?? row.rule}  (${row.rule})`);
  }

  if (recent.length > 0) {
    ui.print(`\nMost recent blocked or asked actions (newest first)`);
    for (const entry of recent) {
      ui.print(`  ${entry.ts}  ${entry.agent}  ${entry.decision === "deny" ? "blocked" : "asked  "}  ${entry.rule}  ${shorten(entry.detail, 80)}`);
    }
  }

  ui.print("\nTip: `agent-guardrails explain <reason>` says why something was blocked and what to do.");
  if (skipped > 0) ui.warn(`${skipped} line(s) of the log could not be read and were skipped.`);
  if (size > AUDIT_MAX_BYTES * 0.8) ui.warn(`The log is ${Math.round(size / 1024 / 1024)} MB; the guard stops writing at ${AUDIT_MAX_BYTES / 1024 / 1024} MB. Move the file somewhere else by hand.`);
  return 0;
}
