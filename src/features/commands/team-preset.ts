import path from "node:path";
import { CONFIG_FILE, parseConfig } from "../../shared/config.ts";
import { applyPlan, normalizeRelPath } from "../../shared/fs-plan.ts";
import { MergeError, planJsonConfig } from "../../shared/json-config.ts";
import { cleanText } from "../alerts/index.ts";
import { PRESET_FILE, PresetError, buildPresetFromConfig, loadPresetFromSource, mergeSettings, serializePreset } from "../team-presets/index.ts";
import { diskSyncIo } from "../rules/index.ts";
import { loadSavedConfig, renderDiff } from "../setup/index.ts";
import { CancelledError, CliError } from "./errors.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";

export interface TeamPresetOptions {
  yes?: boolean;
  dryRun?: boolean;
  /** Name written into an exported preset. */
  name?: string;
  description?: string;
}

async function load(ctx: CommandContext) {
  const root = findProjectRoot(ctx.cwd);
  const io = diskSyncIo(root);
  const saved = await loadSavedConfig(io);
  if (saved === null) throw new CliError("No saved settings found. Run `agent-guardrails init` first.");
  return { root, io, saved };
}

const asCliError = (error: unknown): unknown => (error instanceof PresetError ? new CliError(error.message) : error);

/**
 * `agent-guardrails preset export [file]`: writes this project's settings as a preset file others can use. It never
 * overwrites a file that is different, and it refuses settings a preset cannot carry.
 */
export async function runPresetExport(ctx: CommandContext, target: string | undefined, options: TeamPresetOptions = {}): Promise<number> {
  const { ui } = ctx;
  const { root, io, saved } = await load(ctx);

  const wanted = target ?? PRESET_FILE;
  if (!wanted.toLowerCase().endsWith(".json")) throw new CliError(`The preset file name must end in .json (got "${cleanText(wanted, 60)}"), for example ${PRESET_FILE}.`);
  let rel: string;
  try {
    rel = normalizeRelPath(wanted);
  } catch {
    throw new CliError(`"${cleanText(wanted, 60)}" is not a path inside the project.`);
  }

  const name = cleanText(options.name ?? (path.basename(root) || "team preset"), 60);
  let content: string;
  try {
    content = serializePreset(buildPresetFromConfig(saved, name, options.description === undefined ? undefined : cleanText(options.description, 300)));
  } catch (error) {
    throw asCliError(error);
  }

  const existing = await io.readExisting(rel);
  if (existing !== null) {
    if (existing.kind === "file" && existing.content === content) {
      ui.success(`${rel} is already up to date.`);
      return 0;
    }
    throw new CliError(`${rel} already exists and is different. Choose another file name, or move it aside yourself: the kit never overwrites it.`);
  }

  ui.print(`${rel} would hold:\n${content.trimEnd()}`);
  if (options.dryRun) {
    ui.info("Dry run: nothing was written.");
    return 0;
  }
  if (!options.yes) {
    if (!ui.interactive) throw new CliError("Run again with --yes to write the file.");
    if (!(await ui.confirm({ message: `Write ${rel}?`, initial: true }))) throw new CancelledError();
  }
  await applyPlan(root, [{ path: rel, content, generated: false, status: "create", existing: null, reason: null }]);
  ui.success(`Wrote ${rel}. Share it by committing it, copying it, or publishing a package with it saved as ${PRESET_FILE}. Use it in another project with: agent-guardrails preset use <file or package>`);
  return 0;
}

/**
 * `agent-guardrails preset use <file or package>`: follows a team preset. The preset can only keep or raise
 * protection; the change is shown as a diff and needs a yes. `update` applies the preset again later.
 */
export async function runPresetUse(ctx: CommandContext, source: string | undefined, options: TeamPresetOptions = {}): Promise<number> {
  const { ui } = ctx;
  if (source === undefined) throw new CliError("Say where the preset is, for example: agent-guardrails preset use ./team-preset.json (or the name of an installed package).");
  const { root, io, saved } = await load(ctx);

  let loaded;
  try {
    loaded = await loadPresetFromSource(root, source);
  } catch (error) {
    throw asCliError(error);
  }
  const merged = mergeSettings(saved, loaded.preset.settings);

  const plan = await planJsonConfig(CONFIG_FILE, io.readExisting, (config) => {
    const next = { ...config, ...merged, extends: loaded.source, extendsHash: loaded.hash };
    try {
      parseConfig(JSON.stringify(next));
    } catch (error) {
      throw new MergeError(error instanceof Error ? error.message : String(error));
    }
    return next;
  });
  if (plan.status === "conflict") throw new CliError(`Could not change ${CONFIG_FILE}: ${plan.reason}`);

  ui.print(`Team preset "${cleanText(loaded.preset.name, 60)}" from ${loaded.source}${loaded.preset.description ? `\n  ${cleanText(loaded.preset.description, 200)}` : ""}`);
  if (plan.status === "unchanged") {
    ui.success("This project already follows that preset.");
    return 0;
  }
  ui.print(renderDiff({ group: "config", file: plan }));
  const added = merged.allowCommands.filter((entry) => !saved.allowCommands.includes(entry));
  if (added.length > 0) ui.warn(`This adds ${added.length} command(s) that will run without asking: ${added.map((entry) => cleanText(entry, 60)).join(", ")}.`);
  ui.info("A preset can only keep or raise protection, and your own settings stay. Whoever controls that file or package controls these settings, so read the diff.");
  if (options.dryRun) {
    ui.info("Dry run: nothing was written.");
    return 0;
  }
  if (!options.yes) {
    if (!ui.interactive) throw new CliError("Run again with --yes to apply the preset.");
    if (!(await ui.confirm({ message: `Follow the team preset "${cleanText(loaded.preset.name, 60)}"?`, initial: false }))) throw new CancelledError();
  }
  await applyPlan(root, [plan]);
  ui.success(`Now following ${loaded.source}. \`agent-guardrails update\` applies it again whenever the preset changes; run it now so the generated agent files follow.`);
  return 0;
}
