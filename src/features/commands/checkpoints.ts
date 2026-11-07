import { cleanText, formatTime } from "../alerts/index.ts";
import { CHECKPOINT_ID, SKIP_REASONS, checkpointUsage, listCheckpoints, readCheckpoint, type Manifest } from "../checkpoints/index.ts";
import { CHECKPOINT_LIMITS } from "../hooks/guard/guard.mjs";
import { diskSyncIo } from "../rules/index.ts";
import { loadSavedConfig } from "../setup/index.ts";
import { CliError } from "./errors.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";

export interface CheckpointsOptions {
  /** How many to list. */
  limit?: number;
}

const kb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function summaryLine(manifest: Manifest): string {
  const names = manifest.files.slice(0, 3).map((file) => cleanText(file.path, 60));
  const more = manifest.files.length > 3 ? `, +${manifest.files.length - 3} more` : "";
  const date = manifest.ts.slice(0, 10);
  return `${manifest.id}  ${date} ${formatTime(manifest.ts)}  ${cleanText(manifest.agent, 12)}  ${cleanText(manifest.tool, 14)}  ${manifest.files.length} file(s)  ${names.join(", ")}${more}`;
}

/**
 * `agent-guardrails checkpoints [id]`: lists the file copies the guard saved before agents changed files, or shows
 * what one checkpoint holds. Reads only.
 */
export async function runCheckpoints(ctx: CommandContext, id?: string, options: CheckpointsOptions = {}): Promise<number> {
  const { ui } = ctx;
  const root = findProjectRoot(ctx.cwd);

  if (id !== undefined) {
    if (!CHECKPOINT_ID.test(id)) throw new CliError(`"${cleanText(id, 40)}" is not a checkpoint id. List them with: agent-guardrails checkpoints`);
    const manifest = await readCheckpoint(root, id);
    if (manifest === null) throw new CliError(`No checkpoint ${id} was found.`);
    ui.print(`Checkpoint ${manifest.id}`);
    ui.print(`  saved ${manifest.ts} before ${cleanText(manifest.agent, 12)} used ${cleanText(manifest.tool, 14)}`);
    for (const file of manifest.files) {
      const state = !file.existed ? "did not exist (the agent created it)" : file.skipped ? `not saved: ${SKIP_REASONS[file.skipped]}` : `saved, ${kb(file.bytes)}`;
      ui.print(`  ${cleanText(file.path, 120)}: ${state}`);
    }
    ui.print(`\nPut the saved files back with: agent-guardrails restore ${manifest.id}`);
    return 0;
  }

  const saved = await loadSavedConfig(diskSyncIo(root));
  const list = await listCheckpoints(root, options.limit ?? 20);
  if (list.length === 0) {
    if (saved !== null && !saved.checkpoints) ui.info('Checkpoints are switched off ("checkpoints": false in the settings), so nothing is being saved.');
    else ui.info("No checkpoints yet. The guard saves a copy of a file the first time an agent changes it.");
    return 0;
  }
  for (const manifest of list) ui.print(summaryLine(manifest));

  const usage = await checkpointUsage(root);
  if (usage !== null) {
    ui.print(`\n${usage.count} saved (limit ${CHECKPOINT_LIMITS.maxCount}), ${kb(usage.bytes)} of ${kb(CHECKPOINT_LIMITS.maxTotalBytes)} used.`);
  }
  ui.print("See one with: agent-guardrails checkpoints <id>     Put it back with: agent-guardrails restore <id>");
  return 0;
}
