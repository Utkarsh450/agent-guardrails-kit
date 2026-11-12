import { detectPackageManager } from "../package-manager/index.ts";
import { diskSyncIo } from "../rules/index.ts";
import { PresetError, loadPresetFromSource, type AppliedPreset } from "../team-presets/index.ts";
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
 * `agent-guardrails-kit update`: refreshes the generated files (guard, git checks, agent configs, AGENTS.md and friends)
 * from the kit's current version, using the settings `init` saved. Your own files are never overwritten, and a rule
 * you deleted is not brought back.
 */
export async function runUpdate(ctx: CommandContext, options: UpdateOptions = {}): Promise<number> {
  const { ui } = ctx;
  ui.intro("agent-guardrails-kit update");

  const root = findProjectRoot(ctx.cwd);
  const io = diskSyncIo(root);
  const saved = await loadSavedConfig(io);
  if (saved === null) {
    throw new CliError("No saved settings found (agent-guardrails.config.json is missing or invalid). Run `agent-guardrails-kit init` first.");
  }
  if (saved.agents.length === 0) {
    throw new CliError("The saved settings list no agents. Run `agent-guardrails-kit init --agents <list>` to choose them.");
  }

  // A project that follows a team preset gets it applied again, in the same reviewed plan. A source that is
  // missing or invalid stops the update: skipping it silently would leave the project on stale settings.
  let teamPreset: AppliedPreset | undefined;
  if (saved.extends !== undefined) {
    try {
      const loaded = await loadPresetFromSource(root, saved.extends);
      teamPreset = { settings: loaded.preset.settings, source: loaded.source, hash: loaded.hash };
      ui.info(`Following the team preset "${loaded.preset.name}" (${loaded.source}).`);
    } catch (error) {
      if (error instanceof PresetError) {
        throw new CliError(`The team preset ${saved.extends} could not be applied: ${error.message} Fix it, or remove "extends" from agent-guardrails.config.json.`);
      }
      throw error;
    }
  }

  const manager = await detectPackageManager(io.readExisting);
  const plan = await buildSetupPlan({
    ...(teamPreset ? { teamPreset } : {}),
    options: { agents: saved.agents, preset: saved.preset, stack: saved.stack, packageManager: manager.manager, github: saved.github, ...(publishedPackage() ? { doctorPackage: publishedPackage()! } : {}) },
    io,
    hooksPathSet: readHooksPath(root),
    createMissingRules: false,
  });

  await reviewAndApply(ui, root, plan, { verb: "update", yes: options.yes, dryRun: options.dryRun, gitConfig: options.gitConfig, diff: options.diff });
  if (!options.dryRun) ui.outro("Update finished. Run `agent-guardrails-kit doctor` to check the result.");
  return 0;
}
