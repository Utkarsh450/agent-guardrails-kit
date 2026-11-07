import { detectPackageManager } from "../package-manager/index.ts";
import { diskSyncIo } from "../rules/index.ts";
import { buildSetupPlan, loadSavedConfig, readHooksPath } from "../setup/index.ts";
import { CliError } from "./errors.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";
import { reviewAndApply } from "./flow.ts";
import { publishedPackage } from "./package-info.ts";

export interface UpdateOptions {
  yes?: boolean;
  dryRun?: boolean;
  gitConfig?: boolean;
  diff?: boolean;
}

/**
 * `agent-guardrails update`: refreshes the generated files (guard, git checks, agent configs, AGENTS.md and friends)
 * from the kit's current version, using the settings `init` saved. Your own files are never overwritten, and a rule
 * you deleted is not brought back.
 */
export async function runUpdate(ctx: CommandContext, options: UpdateOptions = {}): Promise<number> {
  const { ui } = ctx;
  ui.intro("agent-guardrails update");

  const root = findProjectRoot(ctx.cwd);
  const io = diskSyncIo(root);
  const saved = await loadSavedConfig(io);
  if (saved === null) {
    throw new CliError("No saved settings found (agent-guardrails.config.json is missing or invalid). Run `agent-guardrails init` first.");
  }
  if (saved.agents.length === 0) {
    throw new CliError("The saved settings list no agents. Run `agent-guardrails init --agents <list>` to choose them.");
  }

  const manager = await detectPackageManager(io.readExisting);
  const plan = await buildSetupPlan({
    options: { agents: saved.agents, preset: saved.preset, stack: saved.stack, packageManager: manager.manager, github: saved.github, ...(publishedPackage() ? { doctorPackage: publishedPackage()! } : {}) },
    io,
    hooksPathSet: readHooksPath(root),
    createMissingRules: false,
  });

  await reviewAndApply(ui, root, plan, { verb: "update", yes: options.yes, dryRun: options.dryRun, gitConfig: options.gitConfig, diff: options.diff });
  if (!options.dryRun) ui.outro("Update finished. Run `agent-guardrails doctor` to check the result.");
  return 0;
}
