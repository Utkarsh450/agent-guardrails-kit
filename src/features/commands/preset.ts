import { CONFIG_FILE, parseConfig } from "../../shared/config.ts";
import { applyPlan } from "../../shared/fs-plan.ts";
import { MergeError, planJsonConfig } from "../../shared/json-config.ts";
import { detectPackageManager } from "../package-manager/index.ts";
import { PRESET_SUMMARY, presetSettings } from "../presets/index.ts";
import { diskSyncIo } from "../rules/index.ts";
import { loadSavedConfig, renderDiff } from "../setup/index.ts";
import { runPresetExport, runPresetUse } from "./team-preset.ts";
import { CancelledError, CliError } from "./errors.ts";
import { parsePreset, parseStack, findProjectRoot, type CommandContext } from "./context.ts";

export interface PresetOptions {
  stack?: string;
  yes?: boolean;
  dryRun?: boolean;
  /** The file or package for `preset use`, or the file to write for `preset export`. */
  target?: string;
  /** Name and description written into an exported preset. */
  name?: string;
  description?: string;
}

/**
 * `agent-guardrails-kit preset <name>`: switches the guard settings to a preset. Unlike `init`, this REPLACES policy,
 * allowCommands, gitAllow, approvalGate and auditAllowed, so it shows the change and asks first.
 */
export async function runPreset(ctx: CommandContext, name: string, options: PresetOptions = {}): Promise<number> {
  const { ui } = ctx;
  // Two more words share this command: `preset export [file]` and `preset use <file or package>`.
  if (name === "export") return runPresetExport(ctx, options.target, options);
  if (name === "use") return runPresetUse(ctx, options.target, options);

  const root = findProjectRoot(ctx.cwd);
  const io = diskSyncIo(root);
  const saved = await loadSavedConfig(io);
  if (saved === null) throw new CliError("No saved settings found. Run `agent-guardrails-kit init` first.");

  const preset = parsePreset(name);
  const stack = options.stack ? parseStack(options.stack) : saved.stack;
  const manager = await detectPackageManager(io.readExisting);
  const settings = presetSettings(preset, stack, manager.manager);

  const plan = await planJsonConfig(CONFIG_FILE, io.readExisting, (config) => {
    const next: Record<string, unknown> = { ...config, ...settings, preset, stack };
    // Choosing a built-in preset ends the team preset: otherwise the next `update` would apply it again.
    delete next.extends;
    delete next.extendsHash;
    try {
      parseConfig(JSON.stringify(next));
    } catch (error) {
      throw new MergeError(error instanceof Error ? error.message : String(error));
    }
    return next;
  });
  if (plan.status === "conflict") throw new CliError(`Could not change ${CONFIG_FILE}: ${plan.reason}`);

  ui.print(`${preset}: ${PRESET_SUMMARY[preset]}`);
  if (plan.status === "unchanged") {
    ui.success(`Already on the ${preset} preset for ${stack}.`);
    return 0;
  }
  ui.print(renderDiff({ group: "config", file: plan }));
  ui.warn("This replaces your policy, allowed commands, git commands, plan gate and logging settings with the preset's.");
  if (options.dryRun) {
    ui.info("Dry run: nothing was written.");
    return 0;
  }
  if (!options.yes) {
    if (!ui.interactive) throw new CliError("Run again with --yes to apply this preset.");
    if (!(await ui.confirm({ message: `Switch to the ${preset} preset?`, initial: false }))) throw new CancelledError();
  }
  await applyPlan(root, [plan]);
  if (saved.extends !== undefined) ui.info(`This project no longer follows the team preset ${saved.extends}; run \`agent-guardrails-kit preset use ${saved.extends}\` to follow it again.`);
  ui.success(`Switched to ${preset}. Run \`agent-guardrails-kit update\` so the generated agent files follow (the learner preset repeats rules per agent).`);
  return 0;
}
