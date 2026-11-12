import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { APPROVAL_FILE, createApprovalRecord, parseApprovalRecord, serializeApproval, verifyApproval } from "../hooks/index.ts";
import { diskSyncIo } from "../rules/index.ts";
import { loadSavedConfig } from "../setup/index.ts";
import { CancelledError, CliError } from "./errors.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";

export interface ApproveOptions {
  yes?: boolean;
  /** Only report whether a plan is approved. Exit code 0 when it is, 1 when it is not. */
  status?: boolean;
  /** Withdraw the current approval. */
  revoke?: boolean;
}

const PREVIEW_LINES = 40;

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * `agent-guardrails-kit approve`: you read the plan the agent wrote, and approve it. Agents can then write files
 * until the plan changes. Only a person should run this; the guard stops agents from editing the approval record.
 */
export async function runApprove(ctx: CommandContext, options: ApproveOptions = {}): Promise<number> {
  const { ui } = ctx;
  const root = findProjectRoot(ctx.cwd);
  const saved = await loadSavedConfig(diskSyncIo(root));
  const planFile = saved?.planFile ?? "PLAN.md";
  const approvalPath = path.join(root, APPROVAL_FILE);

  const planText = await readText(path.join(root, planFile));
  const record = parseApprovalRecord((await readText(approvalPath)) ?? "");
  const state = verifyApproval(record, planFile, planText);

  if (options.status) {
    if (state.approved) ui.success(`${planFile} is approved (${record?.approvedAt ?? "unknown time"}).`);
    else ui.info(`No approved plan: ${state.reason}.`);
    return state.approved ? 0 : 1;
  }

  if (options.revoke) {
    if (!state.approved && record === null) {
      ui.info("There is no approval to revoke.");
      return 0;
    }
    if (!options.yes) {
      if (!ui.interactive) throw new CliError("Run again with --yes to revoke the approval.");
      if (!(await ui.confirm({ message: "Revoke the approval? Agents will not be able to write files until you approve a plan again.", initial: true }))) throw new CancelledError();
    }
    // Overwritten with a marker instead of deleted: the kit never deletes files.
    await mkdir(path.dirname(approvalPath), { recursive: true });
    await writeFile(approvalPath, `${JSON.stringify({ version: 1, revoked: true, revokedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    ui.success("Approval revoked.");
    return 0;
  }

  if (planText === null) {
    throw new CliError(`There is no ${planFile} yet. Ask your agent to write its plan to ${planFile}, read it, then run this again.`);
  }
  if (planText.trim() === "") throw new CliError(`${planFile} is empty. Ask your agent to write the plan first.`);
  if (saved && !saved.approvalGate) ui.warn("The plan gate is switched off in the settings (approvalGate: false), so approving has no effect.");

  const lines = planText.split("\n");
  ui.print(`${planFile} (${lines.length} lines)`);
  ui.print(lines.slice(0, PREVIEW_LINES).map((l) => `  | ${l}`).join("\n"));
  if (lines.length > PREVIEW_LINES) ui.print(`  | ... ${lines.length - PREVIEW_LINES} more lines. Read the whole file before you approve.`);

  if (state.approved) {
    ui.success("This exact plan is already approved.");
    return 0;
  }
  if (!options.yes) {
    if (!ui.interactive) throw new CliError("Read the plan, then run again with --yes to approve it.");
    if (!(await ui.confirm({ message: `Approve this plan? Agents may then write files until ${planFile} changes.`, initial: false }))) throw new CancelledError();
  }

  const next = createApprovalRecord(planFile, planText);
  await mkdir(path.dirname(approvalPath), { recursive: true });
  await writeFile(approvalPath, serializeApproval(next), "utf8");
  ui.success(`Approved ${planFile} (fingerprint ${next.sha256.slice(0, 12)}). If the file changes, the approval ends.`);
  return 0;
}
