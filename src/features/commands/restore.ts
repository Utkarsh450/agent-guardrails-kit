import { normalizeRelPath, applyPlan } from "../../shared/fs-plan.ts";
import { cleanText } from "../alerts/index.ts";
import { CHECKPOINT_ID, planRestore, readCheckpoint } from "../checkpoints/index.ts";
import { renderDiff } from "../setup/index.ts";
import { CancelledError, CliError } from "./errors.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";

export interface RestoreOptions {
  /** Restore only this file of the checkpoint. */
  file?: string;
  yes?: boolean;
}

/**
 * `agent-guardrails restore <id>`: puts back the files a checkpoint saved. It shows a diff first and asks. It never
 * deletes: a file the agent created is only reported. Only a person should run this; the guard stops agents from running it.
 */
export async function runRestore(ctx: CommandContext, id: string, options: RestoreOptions = {}): Promise<number> {
  const { ui } = ctx;
  const root = findProjectRoot(ctx.cwd);
  if (!CHECKPOINT_ID.test(id)) throw new CliError(`"${cleanText(id, 40)}" is not a checkpoint id. List them with: agent-guardrails checkpoints`);
  const manifest = await readCheckpoint(root, id);
  if (manifest === null) throw new CliError(`No checkpoint ${id} was found (or its manifest is not valid).`);

  let only: string | undefined;
  if (options.file !== undefined) {
    try {
      only = normalizeRelPath(options.file);
    } catch {
      throw new CliError(`--file must be a path inside the project, such as src/app.ts (got "${cleanText(options.file, 60)}").`);
    }
    if (!manifest.files.some((file) => file.path === only)) throw new CliError(`Checkpoint ${id} has no file "${only}". See: agent-guardrails checkpoints ${id}`);
  }

  const plan = await planRestore(root, manifest, only);

  for (const path of plan.createdByAgent) {
    ui.info(`${cleanText(path, 120)} was created by the agent. Restore never deletes: delete it yourself if you want it gone.`);
  }
  for (const item of plan.skipped) ui.warn(`${cleanText(item.path, 120)} cannot be restored: ${item.reason}.`);
  if (plan.unchanged.length > 0) ui.info(`${plan.unchanged.length} file(s) already match the saved copy.`);

  if (plan.files.length === 0) {
    ui.info("Nothing to put back.");
    return 0;
  }
  for (const file of plan.files) {
    ui.print(`\n${file.path} (${file.status === "create" ? "will be created again" : "will be overwritten"})`);
    ui.print(renderDiff({ group: "config", file }));
  }
  ui.warn(`This overwrites the current content of ${plan.files.length} file(s) with what was saved at ${manifest.ts}.`);

  if (!options.yes) {
    if (!ui.interactive) throw new CliError("Run again with --yes to restore.");
    if (!(await ui.confirm({ message: `Restore ${plan.files.length} file(s) from checkpoint ${id}?`, initial: false }))) throw new CancelledError();
  }
  const written = await applyPlan(root, plan.files);
  ui.success(`Restored ${written.length} file(s) from ${id}. The checkpoint itself is kept.`);
  return 0;
}
