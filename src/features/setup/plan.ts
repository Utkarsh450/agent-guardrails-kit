import { CONFIG_FILE, parseConfig, ConfigError, type GuardrailsConfig } from "../../shared/config.ts";
import { planFiles, type PlannedFile } from "../../shared/fs-plan.ts";
import { MergeError, planJsonConfig, type JsonObject } from "../../shared/json-config.ts";
import { ENFORCEMENT, planAgents } from "../agents/index.ts";
import { branchProtectionCommand, planGithubFiles } from "../github/index.ts";
import { HOOKS_PATH_COMMAND, planGitFiles } from "../git/index.ts";
import { GUARD_INSTALL_PATH, guardSource } from "../hooks/index.ts";
import { PRESETS, STACKS, presetSettings } from "../presets/index.ts";
import { DEFAULT_RULES_DIR, defaultRuleSources, planSync, type SyncIo } from "../rules/index.ts";
import { mergeSettings, type AppliedPreset } from "../team-presets/index.ts";
import type { Note, PlanEntry, PlanGroup, SetupOptions, SetupPlan } from "./types.ts";

export interface PlanInputs {
  options: SetupOptions;
  /** Reads the project (disk in real use, memory in tests). */
  io: SyncIo;
  /** Result of `git config --get core.hooksPath`, or null when it could not be checked. */
  hooksPathSet: boolean | null;
  /**
   * Create default rule files that are missing. `init` does (it restores the defaults); `update` does not,
   * so a rule the person deliberately deleted is not quietly brought back.
   */
  createMissingRules?: boolean;
  /** A team preset the project follows (`update` passes it). Applied to the settings file in this same plan. */
  teamPreset?: AppliedPreset;
}

function tag(group: PlanGroup, files: readonly PlannedFile[]): PlanEntry[] {
  return files.map((file) => ({ group, file }));
}

/** Builds the config file content: guard settings only when missing, CLI settings always current. */
function configTransform(options: SetupOptions, teamPreset?: AppliedPreset) {
  const settings = presetSettings(options.preset, options.stack, options.packageManager);
  return (config: JsonObject): JsonObject => {
    const next: JsonObject = {};
    const guardDefaults: JsonObject = {
      version: 1,
      policy: settings.policy,
      allowCommands: settings.allowCommands,
      gitAllow: settings.gitAllow,
      approvalGate: settings.approvalGate,
      planFile: "PLAN.md",
      auditAllowed: settings.auditAllowed,
    };
    // Existing guard settings belong to the person; only missing ones are filled in.
    for (const [key, value] of Object.entries(guardDefaults)) next[key] = key in config ? config[key] : value;
    // CLI settings follow the choices made now.
    next.agents = options.agents;
    next.preset = options.preset;
    next.stack = options.stack;
    next.alwaysRuleFiles = "alwaysRuleFiles" in config && typeof config.alwaysRuleFiles === "boolean" ? config.alwaysRuleFiles : settings.alwaysRuleFiles;
    next.github = options.github;
    // Anything else the person added stays where it was.
    for (const [key, value] of Object.entries(config)) if (!(key in next)) next[key] = value;

    try {
      const project = parseConfig(JSON.stringify(next));
      if (teamPreset) {
        // The team preset can only keep or raise protection, and the project's own entries stay.
        Object.assign(next, mergeSettings(project, teamPreset.settings), { extends: teamPreset.source, extendsHash: teamPreset.hash });
        parseConfig(JSON.stringify(next));
      }
    } catch (error) {
      if (error instanceof ConfigError) throw new MergeError(`the existing settings are invalid, so nothing was changed (${error.message})`);
      throw error;
    }
    return next;
  };
}

/** Reads the settings a previous init saved, or null when the project has none (or they are broken). */
export async function loadSavedConfig(io: SyncIo): Promise<GuardrailsConfig | null> {
  const existing = await io.readExisting(CONFIG_FILE);
  if (existing === null || existing.kind !== "file") return null;
  try {
    return parseConfig(existing.content);
  } catch {
    return null;
  }
}

/**
 * Works out everything init or update would do, without writing anything:
 * rules, guard, per-agent configs, git hooks, GitHub files and the settings file.
 */
export async function buildSetupPlan({ options, io, hooksPathSet, createMissingRules = true, teamPreset }: PlanInputs): Promise<SetupPlan> {
  const read = io.readExisting;
  const entries: PlanEntry[] = [];

  // 1. Rule sources (the person's own files after creation; existing ones are kept).
  const plannedRules = await planFiles(
    defaultRuleSources.map((source) => ({ path: `${DEFAULT_RULES_DIR}/${source.path}`, content: source.content, generated: false })),
    read,
  );
  const ruleFiles = createMissingRules ? plannedRules : plannedRules.filter((file) => file.status !== "create");
  entries.push(...tag("rules", ruleFiles));

  // 2. The settings file.
  const config = await planJsonConfig(CONFIG_FILE, read, configTransform(options, teamPreset));
  entries.push(...tag("config", [config]));

  // 3. Generated agent files, planned against what the rule folder WILL contain.
  const pending = new Map(ruleFiles.filter((f) => f.status === "create").map((f) => [f.path, f.content]));
  const overlay: SyncIo = {
    readExisting: async (rel) => (pending.has(rel) ? { kind: "file", content: pending.get(rel) ?? "" } : read(rel)),
    async listFiles(dir) {
      const names = new Set(await io.listFiles(dir));
      for (const path of pending.keys()) {
        if (path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/")) names.add(path.slice(dir.length + 1));
      }
      return [...names].sort();
    },
  };
  const effectiveAlwaysFiles = (() => {
    const planned = config.status === "conflict" ? null : (JSON.parse(config.content) as { alwaysRuleFiles?: boolean });
    return planned?.alwaysRuleFiles ?? false;
  })();
  const sync = await planSync(overlay, { agents: options.agents, alwaysRuleFiles: effectiveAlwaysFiles });
  entries.push(...tag("rules", sync.files));

  // 4. The guard and the per-agent hook configs.
  entries.push(...tag("guard", await planFiles([{ path: GUARD_INSTALL_PATH, content: guardSource, generated: true }], read)));
  const agentPlans = await planAgents(read, options.agents);
  entries.push(...tag("agents", agentPlans.flatMap((plan) => plan.files)));

  // 5. Git hooks and the .gitignore blocks.
  entries.push(...tag("git", await planGitFiles(read)));

  // 6. GitHub files.
  if (options.github) {
    entries.push(...tag("github", await planGithubFiles(read, options.doctorPackage ? { doctor: options.doctorPackage } : {})));
  }

  const isRepo = (await read(".git")) !== null;
  const notes: Note[] = [];
  for (const plan of agentPlans) notes.push({ title: plan.agent, lines: plan.notes });
  if (!isRepo) {
    notes.push({
      title: "git",
      lines: [
        "This folder is not a git repository yet. After you run `git init`, turn the hooks on with:",
        `  ${HOOKS_PATH_COMMAND}`,
      ],
    });
  } else if (hooksPathSet !== true) {
    notes.push({
      title: "git",
      lines: [`The git hooks only run after this one-time setting in each clone (init offers to do it):`, `  ${HOOKS_PATH_COMMAND}`],
    });
  }
  if (options.github) {
    notes.push({
      title: "github",
      lines: [
        "Optional: protect your main branch on GitHub (no force pushes, required checks and review). You run this yourself, once. Replace OWNER, REPO and the branch:",
        `  ${branchProtectionCommand({ owner: "OWNER", repo: "REPO", branch: "main" }).split("\n")[0]} ...`,
        "(`agent-guardrails explain branch-protection` prints the full command.) Also edit .github/CODEOWNERS and put your username in it.",
      ],
    });
  }

  return {
    options,
    entries,
    notes,
    warnings: sync.warnings,
    stale: sync.stale,
    enforcement: options.agents.map((agent) => ({ agent, enforcement: ENFORCEMENT[agent] })),
    git: { isRepo, hooksPathSet, command: HOOKS_PATH_COMMAND },
  };
}

export { PRESETS, STACKS };
