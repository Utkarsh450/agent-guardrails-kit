import { applySync, diskSyncIo, planSync } from "../rules/index.ts";
import { renderDiff, loadSavedConfig } from "../setup/index.ts";
import { CancelledError, CliError } from "./errors.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";

export interface SyncCommandOptions {
  /** Exit 1 when anything is out of date, and write nothing (for CI). */
  check?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

/** `agent-guardrails-kit sync`: regenerates AGENTS.md, CLAUDE.md and the per-agent rule files from agent-rules/. */
export async function runSync(ctx: CommandContext, options: SyncCommandOptions = {}): Promise<number> {
  const { ui } = ctx;
  const root = findProjectRoot(ctx.cwd);
  const io = diskSyncIo(root);
  const saved = await loadSavedConfig(io);
  if (saved === null || saved.agents.length === 0) {
    throw new CliError("No saved agents found. Run `agent-guardrails-kit init` first so it knows which files to generate.");
  }

  const plan = await planSync(io, { agents: saved.agents, alwaysRuleFiles: saved.alwaysRuleFiles });
  const changes = plan.files.filter((f) => f.status === "create" || f.status === "update");
  const kept = plan.files.filter((f) => f.status === "conflict");

  for (const file of changes) ui.print(`  ${file.status === "create" ? "+" : "~"} ${file.path}`);
  for (const file of kept) ui.print(`  - ${file.path}  (${file.reason})`);
  for (const path of plan.stale) ui.warn(`${path} no longer matches any rule. Remove it by hand if you do not need it.`);
  for (const warning of plan.warnings) ui.warn(warning);

  if (changes.length === 0) {
    ui.success("The generated agent files already match the rules.");
    return 0;
  }
  if (options.check) {
    ui.error(`${changes.length} generated file(s) are out of date. Run \`agent-guardrails-kit sync\`.`);
    return 1;
  }
  if (options.dryRun) {
    ui.info("Dry run: nothing was written.");
    return 0;
  }
  if (!options.yes) {
    if (!ui.interactive) throw new CliError("This would write files. Run again with --yes (or --check / --dry-run).");
    const shown = changes.filter((f) => f.status === "update");
    if (shown.length > 0 && (await ui.confirm({ message: "Show what changes first?", initial: false }))) {
      for (const file of shown) ui.print(`\n${file.path}\n${renderDiff({ group: "rules", file })}`);
    }
    if (!(await ui.confirm({ message: `Write ${changes.length} file(s)?`, initial: true }))) throw new CancelledError();
  }
  const written = await applySync(root, plan);
  ui.success(`Wrote ${written.length} file(s).`);
  return 0;
}
