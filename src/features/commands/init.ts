import { AGENT_IDS, AGENT_LABELS, type AgentId } from "../../shared/agents.ts";
import type { Preset, Stack } from "../../shared/config.ts";
import { ENFORCEMENT, detectAgents } from "../agents/index.ts";
import { detectPackageManager } from "../package-manager/index.ts";
import { PRESETS, PRESET_SUMMARY, STACKS, STACK_SUMMARY, detectStack } from "../presets/index.ts";
import { diskSyncIo } from "../rules/index.ts";
import { buildSetupPlan, loadSavedConfig, readHooksPath, type SetupOptions } from "../setup/index.ts";
import { CliError } from "./errors.ts";
import { findProjectRoot, parseAgentList, parsePreset, parseStack, resolveRoot, type CommandContext } from "./context.ts";
import { reviewAndApply } from "./flow.ts";
import { publishedPackage } from "./package-info.ts";

export interface InitOptions {
  /** Comma separated agent ids, or "all". */
  agents?: string;
  preset?: string;
  stack?: string;
  /** false when --no-github was given. */
  github?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  gitConfig?: boolean;
  diff?: boolean;
}

/** `agent-guardrails init`: choose, review the plan, approve, write. */
export async function runInit(ctx: CommandContext, options: InitOptions = {}): Promise<number> {
  const { ui } = ctx;
  ui.intro("agent-guardrails init", { big: true });

  const root = resolveRoot(ctx.cwd);
  const outer = findProjectRoot(ctx.cwd);
  if (outer !== root) ui.warn(`This folder is inside ${outer}, which is already set up. Run the command there to change that project. Continuing here sets up a separate, nested project.`);
  const io = diskSyncIo(root);
  const read = io.readExisting;

  const saved = await loadSavedConfig(io);
  const detected = await detectAgents(read);
  const manager = await detectPackageManager(read);
  const stackGuess = await detectStack(read);
  const choosing = ui.interactive && !options.yes;

  // Which agents
  let agents: AgentId[];
  if (options.agents !== undefined) {
    agents = parseAgentList(options.agents);
  } else if (choosing) {
    const initial = saved?.agents.length ? saved.agents : detected.length > 0 ? detected.map((d) => d.agent) : (["claude"] as AgentId[]);
    agents = await ui.multiselect({
      message: "Which AI agents do you use?",
      choices: AGENT_IDS.map((id) => ({
        value: id,
        label: AGENT_LABELS[id],
        hint: ENFORCEMENT[id] === "enforced" ? "hook blocks actions" : "rules only",
      })),
      initial,
    });
  } else if (saved?.agents.length) {
    agents = saved.agents;
  } else if (options.yes && detected.length > 0) {
    agents = detected.map((d) => d.agent);
    ui.info(`Using the agents found in this project: ${agents.map((a) => AGENT_LABELS[a]).join(", ")}`);
  } else {
    throw new CliError(`Say which agents to set up, for example: --agents claude,cursor (choose from ${AGENT_IDS.join(", ")} or "all").`);
  }

  // Which preset
  let preset: Preset;
  if (options.preset !== undefined) preset = parsePreset(options.preset);
  else if (choosing) {
    preset = await ui.select({
      message: "How strict should it be?",
      choices: PRESETS.map((p) => ({ value: p, label: p, hint: PRESET_SUMMARY[p] })),
      initial: saved?.preset ?? "balanced",
    });
  } else preset = saved?.preset ?? "balanced";

  // Which stack
  let stack: Stack;
  if (options.stack !== undefined) stack = parseStack(options.stack);
  else if (choosing) {
    stack = await ui.select({
      message: stackGuess.evidence ? `What kind of project is this? (looks like ${stackGuess.stack}, from ${stackGuess.evidence})` : "What kind of project is this?",
      choices: STACKS.map((s) => ({ value: s, label: s, hint: STACK_SUMMARY[s] })),
      initial: saved?.stack ?? stackGuess.stack,
    });
  } else stack = saved?.stack ?? stackGuess.stack;

  // GitHub files
  let github: boolean;
  if (options.github === false) github = false;
  else if (choosing) github = await ui.confirm({ message: "Add GitHub files (pull request template, CODEOWNERS and a CI check)?", initial: saved?.github ?? true });
  else github = saved?.github ?? true;

  if (manager.ambiguous.length > 0) {
    ui.warn(`More than one package manager's lockfile is present (${manager.ambiguous.join(", ")}). Using ${manager.manager}. Keep only one.`);
  }

  const doctorPackage = publishedPackage();
  const setup: SetupOptions = { agents, preset, stack, packageManager: manager.manager, github, ...(doctorPackage ? { doctorPackage } : {}) };
  const plan = await buildSetupPlan({ options: setup, io, hooksPathSet: readHooksPath(root) });

  await reviewAndApply(ui, root, plan, {
    verb: "init",
    yes: options.yes,
    dryRun: options.dryRun,
    gitConfig: options.gitConfig,
    diff: options.diff,
  });

  if (!options.dryRun) {
    ui.outro("Done. Next: `agent-guardrails doctor` checks the setup, and `agent-guardrails test --hooks` proves the guard blocks what it should.");
  }
  return 0;
}
