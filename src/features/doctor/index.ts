import { AGENT_LABELS, type AgentId } from "../../shared/agents.ts";
import { CONFIG_FILE, ConfigError, parseConfig, type GuardrailsConfig } from "../../shared/config.ts";
import { isGenerated, planFiles, type PlannedFile } from "../../shared/fs-plan.ts";
import { planTextBlocks } from "../../shared/text-block.ts";
import { detectAgents } from "../agents/index.ts";
import { desiredGithubFiles } from "../github/index.ts";
import { HOOKS_PATH_COMMAND, desiredGitFiles } from "../git/index.ts";
import { diffDependencies } from "../dependencies/index.ts";
import type { CheckpointUsage } from "../checkpoints/index.ts";
import { isBehind, type TeamPresetStatus } from "../team-presets/index.ts";
import { CHECKPOINT_DIR, CHECKPOINT_LIMITS, watchActive } from "../hooks/guard/guard.mjs";
import { AUDIT_FILE, AUDIT_MAX_BYTES, GUARD_INSTALL_PATH, STATE_GITIGNORE_LINES, guardSource, parseApprovalRecord, verifyApproval } from "../hooks/index.ts";
import { BROAD_PROGRAMS, PRESET_SUMMARY } from "../presets/index.ts";
import { loadRules, planSync, RuleError, type SyncIo, DEFAULT_RULES_DIR } from "../rules/index.ts";
import { SECRETS_GITIGNORE_LINES } from "../secrets/index.ts";
import { agentChecks } from "./agents.ts";
import { summarizeChecks, type Check, type DoctorResult } from "./types.ts";

export { summarizeChecks, type Check, type DoctorResult, type Status } from "./types.ts";

export interface DoctorInput {
  io: SyncIo;
  /** Whether git's core.hooksPath is the kit's folder; null when it could not be checked. */
  hooksPathSet: boolean | null;
  /** process.version of the Node running the check, for example "v24.19.0". */
  nodeVersion: string;
  /** Size of the audit log in bytes, or null when there is none. */
  auditBytes: number | null;
  /** Text of ~/.gemini/antigravity-cli/settings.json, only when the person asked to check it. */
  antigravityUserSettings?: string | null;
  /** The current time; tests pass a fixed one. */
  now?: Date;
  /** How many checkpoints the guard has saved and how much they hold, or null when there are none. */
  checkpoints?: CheckpointUsage | null;
  /** What was found when the team preset named in `extends` was read. Only given when the project has one. */
  teamPreset?: TeamPresetStatus;
}

/** Programs that run whatever script they are given; allowing them with no arguments allows almost anything. */

const text = (file: { content: string } | null) => file?.content ?? "";

/** Looks at everything the kit installs and says what works, what is out of date and what is missing. */
export async function diagnose(input: DoctorInput): Promise<DoctorResult> {
  const { io } = input;
  const read = io.readExisting;
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);

  // ── Settings ──
  let config: GuardrailsConfig | null = null;
  const configFile = await read(CONFIG_FILE);
  if (configFile === null) {
    add({ id: "config", area: "Settings", title: "Settings file", status: "fail", detail: `${CONFIG_FILE} does not exist. Without it the guard uses its built-in defaults and nothing remembers your choices.`, fix: "agent-guardrails init" });
  } else {
    try {
      config = parseConfig(text(configFile));
      add({ id: "config", area: "Settings", title: "Settings file", status: "ok", detail: `${config.preset} preset, ${config.stack} stack. ${PRESET_SUMMARY[config.preset]}` });
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : String(error);
      add({ id: "config", area: "Settings", title: "Settings file", status: "fail", detail: `${message}. The guard blocks everything while the settings are invalid.`, fix: `Fix ${CONFIG_FILE} by hand` });
    }
  }

  if (config) {
    if (config.policy === "blocklist") {
      add({ id: "policy", area: "Settings", title: "Unknown commands", status: "warn", detail: 'policy is "blocklist": commands the guard does not recognise run without asking.', fix: 'Set "policy": "ask" in the settings file' });
    }
    if (config.mode === "watch") {
      add(
        watchActive(config, input.now ?? new Date())
          ? { id: "watch", area: "Settings", title: "Watch mode", status: "warn", detail: `Watch mode is on until ${config.watchUntil}: actions the guard would ask about run without asking and are logged. Blocked actions are still blocked.`, fix: "agent-guardrails mode enforce" }
          : { id: "watch", area: "Settings", title: "Watch mode", status: "info", detail: 'mode is "watch" but there is no valid end date within the next 30 days, so the guard is enforcing.', fix: "agent-guardrails mode enforce" },
      );
    }
    if (!config.checkpoints) {
      add({ id: "checkpoints", area: "Guard", title: "Checkpoints", status: "info", detail: 'Checkpoints are off ("checkpoints": false), so an agent\'s file changes are not saved first and `restore` has nothing to offer.', fix: 'Set "checkpoints": true to turn them on' });
    } else if (input.checkpoints) {
      const { count, bytes } = input.checkpoints;
      const mb = (bytes / 1024 / 1024).toFixed(1);
      const limitMb = CHECKPOINT_LIMITS.maxTotalBytes / 1024 / 1024;
      const used = `${count} saved (limit ${CHECKPOINT_LIMITS.maxCount}), ${mb} MB of ${limitMb} MB used`;
      const cleanup = `Move or remove ${CHECKPOINT_DIR} by hand when you no longer need the copies`;
      if (count >= CHECKPOINT_LIMITS.maxCount || bytes >= CHECKPOINT_LIMITS.maxTotalBytes) {
        add({ id: "checkpoints", area: "Guard", title: "Checkpoints", status: "warn", detail: `${used}. The limit is reached, so no new copies are saved. The guard never deletes or rotates them.`, fix: cleanup });
      } else if (count >= CHECKPOINT_LIMITS.maxCount * 0.8 || bytes >= CHECKPOINT_LIMITS.maxTotalBytes * 0.8) {
        add({ id: "checkpoints", area: "Guard", title: "Checkpoints", status: "warn", detail: `${used}. Close to the limit.`, fix: cleanup });
      } else {
        add({ id: "checkpoints", area: "Guard", title: "Checkpoints", status: "ok", detail: used });
      }
    }
    if (config.extends !== undefined) {
      const status = input.teamPreset;
      if (status === undefined) {
        add({ id: "team-preset", area: "Settings", title: "Team preset", status: "info", detail: `This project follows ${config.extends}; it was not checked.` });
      } else if (status.state === "error") {
        add({ id: "team-preset", area: "Settings", title: "Team preset", status: "fail", detail: `${status.source} cannot be used: ${status.error}`, fix: `Fix the source, or remove "extends" from ${CONFIG_FILE}` });
      } else if (isBehind(config, status.settings)) {
        add({ id: "team-preset", area: "Settings", title: "Team preset", status: "warn", detail: `The settings are behind the team preset "${status.name}" (${status.source}): applying it would add or raise something.`, fix: "agent-guardrails update" });
      } else if (config.extendsHash !== status.hash) {
        add({ id: "team-preset", area: "Settings", title: "Team preset", status: "warn", detail: `The team preset "${status.name}" (${status.source}) changed since it was applied. Entries it no longer lists stay in this project until you remove them.`, fix: "agent-guardrails update" });
      } else {
        add({ id: "team-preset", area: "Settings", title: "Team preset", status: "ok", detail: `Follows "${status.name}" (${status.source}) and is up to date.` });
      }
    }
    if (!config.approvalGate) {
      add({ id: "gate", area: "Settings", title: "Plan approval", status: "warn", detail: "approvalGate is off: agents can write files without an approved plan.", fix: 'Set "approvalGate": true' });
    }
    const broad = config.allowCommands.filter((pattern) => {
      const tokens = pattern.trim().split(/\s+/);
      return tokens.length === 1 && BROAD_PROGRAMS.has(tokens[0] ?? "");
    });
    if (broad.length > 0) {
      add({ id: "allow-broad", area: "Settings", title: "Allowed commands", status: "warn", detail: `These entries let an agent run any script or arguments without asking: ${broad.join(", ")}.`, fix: 'Narrow them, for example "node scripts/build.mjs"' });
    }
  }

  // ── Guard ──
  const guard = await read(GUARD_INSTALL_PATH);
  if (guard === null || guard.kind !== "file") {
    add({ id: "guard", area: "Guard", title: "Guard script", status: "fail", detail: `${GUARD_INSTALL_PATH} does not exist, so no agent is checked.`, fix: "agent-guardrails init" });
  } else if (guard.content === guardSource.replaceAll("\r\n", "\n")) {
    add({ id: "guard", area: "Guard", title: "Guard script", status: "ok", detail: "Installed and identical to this version of the kit." });
  } else if (isGenerated(guard.content)) {
    add({ id: "guard", area: "Guard", title: "Guard script", status: "warn", detail: "It differs from this version of the kit: either it is older or someone edited it.", fix: "agent-guardrails update" });
  } else {
    add({ id: "guard", area: "Guard", title: "Guard script", status: "fail", detail: `${GUARD_INSTALL_PATH} is not the kit's guard.`, fix: "agent-guardrails update (or move the file away first)" });
  }
  const major = Number(/^v?(\d+)/.exec(input.nodeVersion)?.[1] ?? 0);
  add(
    major >= 18
      ? { id: "node", area: "Guard", title: "Node", status: "ok", detail: `${input.nodeVersion}. Agents run the guard with the node on their PATH, which must also be Node 18 or newer.` }
      : { id: "node", area: "Guard", title: "Node", status: "fail", detail: `${input.nodeVersion} is too old for the guard (needs Node 18 or newer).`, fix: "Install a newer Node" },
  );

  // ── Agents ──
  const detected = await detectAgents(read);
  const agents: AgentId[] = config?.agents.length ? config.agents : detected.map((d) => d.agent);
  if (agents.length === 0) {
    add({ id: "agents", area: "Agents", title: "Agents", status: "warn", detail: "No agents are set up and none were found in this folder.", fix: "agent-guardrails init" });
  }
  for (const agent of agents) {
    for (const check of await agentChecks(agent, read, { antigravityUserSettings: input.antigravityUserSettings ?? null })) add(check);
  }
  for (const found of detected.filter((d) => !agents.includes(d.agent))) {
    add({ id: `agent.${found.agent}.unprotected`, area: "Agents", title: `${AGENT_LABELS[found.agent]} is used here but not protected`, status: "warn", detail: `Found ${found.evidence.join(", ")}, but ${AGENT_LABELS[found.agent]} is not set up.`, fix: `agent-guardrails init --agents ${[...agents, found.agent].join(",")}` });
  }

  // ── Rules ──
  let rulesOk = false;
  try {
    const rules = await loadRules(io, DEFAULT_RULES_DIR);
    rulesOk = true;
    add({ id: "rules", area: "Rules", title: "Rule sources", status: "ok", detail: `${rules.filter((r) => r.scope === "always").length} always-on and ${rules.filter((r) => r.scope === "scoped").length} scoped rules in ${DEFAULT_RULES_DIR}/.` });
  } catch (error) {
    add({ id: "rules", area: "Rules", title: "Rule sources", status: "fail", detail: error instanceof RuleError ? error.message : String(error), fix: "agent-guardrails init" });
  }
  if (rulesOk && agents.length > 0) {
    try {
      const sync = await planSync(io, { agents, alwaysRuleFiles: config?.alwaysRuleFiles ?? false });
      const stale = sync.files.filter((f) => f.status === "create" || f.status === "update");
      if (stale.length > 0) {
        add({ id: "rules.sync", area: "Rules", title: "Generated agent files", status: "warn", detail: `${stale.length} file(s) do not match the rules: ${stale.map((f) => f.path).join(", ")}.`, fix: "agent-guardrails sync" });
      } else {
        add({ id: "rules.sync", area: "Rules", title: "Generated agent files", status: "ok", detail: "AGENTS.md and the per-agent files match the rules." });
      }
      for (const file of sync.files.filter((f) => f.status === "conflict")) {
        add({ id: "rules.conflict", area: "Rules", title: `${file.path} is yours`, status: "info", detail: `${file.reason}. The kit leaves it alone, so the agent reads your version.` });
      }
      for (const file of sync.stale) add({ id: "rules.stale", area: "Rules", title: `${file} is left over`, status: "warn", detail: "Its source rule no longer exists. Remove it by hand if you do not need it." });
      for (const warning of sync.warnings) add({ id: "rules.size", area: "Rules", title: "Rule size", status: "warn", detail: warning });
    } catch (error) {
      add({ id: "rules.sync", area: "Rules", title: "Generated agent files", status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  // ── Git ──
  const isRepo = (await read(".git")) !== null;
  if (!isRepo) {
    add({ id: "git.repo", area: "Git", title: "Git repository", status: "info", detail: "This folder is not a git repository, so the git hooks are not active yet.", fix: `git init, then ${HOOKS_PATH_COMMAND}` });
  } else {
    if (input.hooksPathSet === true) add({ id: "git.hooks-path", area: "Git", title: "Git hooks switched on", status: "ok", detail: "core.hooksPath points at .githooks." });
    else if (input.hooksPathSet === false) add({ id: "git.hooks-path", area: "Git", title: "Git hooks switched on", status: "fail", detail: "core.hooksPath is not set to .githooks, so git ignores the hooks. This is a setting in each clone.", fix: HOOKS_PATH_COMMAND });
    else add({ id: "git.hooks-path", area: "Git", title: "Git hooks switched on", status: "info", detail: "Could not ask git whether core.hooksPath is set.", fix: HOOKS_PATH_COMMAND });
  }
  const gitFiles: PlannedFile[] = await planFiles(desiredGitFiles(), read);
  for (const file of gitFiles) {
    const label = file.path;
    if (file.status === "create") add({ id: `git.file.${label}`, area: "Git", title: label, status: isRepo ? "fail" : "warn", detail: "Missing.", fix: "agent-guardrails init" });
    else if (file.status === "update" && file.existing === file.content) add({ id: `git.file.${label}`, area: "Git", title: label, status: "fail", detail: "Is not executable. Git silently skips a hook that is not executable.", fix: `chmod +x ${label}` });
    else if (file.status === "update" || file.status === "conflict") add({ id: `git.file.${label}`, area: "Git", title: label, status: "warn", detail: file.status === "conflict" ? file.reason ?? "Not the kit's file." : "Older or edited.", fix: "agent-guardrails update" });
    else add({ id: `git.file.${label}`, area: "Git", title: label, status: "ok" });
  }
  const ignore = await planTextBlocks(".gitignore", [{ id: "state", lines: STATE_GITIGNORE_LINES }, { id: "secrets", lines: SECRETS_GITIGNORE_LINES }], read);
  add(
    ignore.status === "unchanged"
      ? { id: "gitignore", area: "Git", title: ".gitignore", status: "ok", detail: "Secret files and local guard state are ignored." }
      : { id: "gitignore", area: "Git", title: ".gitignore", status: "warn", detail: "The kit's ignore rules for secret files and local guard state are missing.", fix: "agent-guardrails update" },
  );

  // ── GitHub ──
  if (config?.github) {
    const missing: string[] = [];
    for (const file of desiredGithubFiles()) if ((await read(file.path)) === null) missing.push(file.path);
    add(
      missing.length === 0
        ? { id: "github", area: "GitHub", title: "GitHub files", status: "ok", detail: "Pull request template, issue templates, CODEOWNERS and the CI workflow are present." }
        : { id: "github", area: "GitHub", title: "GitHub files", status: "info", detail: `Missing: ${missing.join(", ")}.`, fix: "agent-guardrails init" },
    );
    const owners = await read(".github/CODEOWNERS");
    if (owners !== null && text(owners).split("\n").every((line) => line.trim() === "" || line.trim().startsWith("#"))) {
      add({ id: "github.codeowners", area: "GitHub", title: "CODEOWNERS", status: "info", detail: "No owner is set yet, so it does not require anyone's review.", fix: "Edit .github/CODEOWNERS and put your username in it" });
    }
  }

  // ── Approval ──
  if (config?.approvalGate ?? true) {
    const planFile = config?.planFile ?? "PLAN.md";
    const plan = await read(planFile);
    const record = parseApprovalRecord(text(await read(".agent-guardrails/approval.json")));
    const state = verifyApproval(record, planFile, plan?.kind === "file" ? plan.content : null);
    add(
      state.approved
        ? { id: "approval", area: "Approval", title: "Plan approval", status: "info", detail: `${planFile} is approved. Agents may write files until it changes.` }
        : { id: "approval", area: "Approval", title: "Plan approval", status: "info", detail: `No approved plan (${state.reason}). Agents cannot write files until you approve one.`, fix: "agent-guardrails approve" },
    );
  }

  // ── Audit log and dependencies ──
  if (input.auditBytes !== null && input.auditBytes > AUDIT_MAX_BYTES * 0.8) {
    add({ id: "audit", area: "Guard", title: "Audit log", status: "warn", detail: `${AUDIT_FILE} is ${Math.round(input.auditBytes / 1024 / 1024)} MB. The guard stops logging at ${AUDIT_MAX_BYTES / 1024 / 1024} MB and never deletes or rotates it.`, fix: `Move ${AUDIT_FILE} somewhere else by hand` });
  }
  const pkg = await read("package.json");
  if (pkg !== null && pkg.kind === "file") {
    try {
      const scripts = diffDependencies({}, JSON.parse(pkg.content)).scripts.filter((s) => s.dangerous);
      for (const script of scripts) {
        add({ id: `deps.${script.name}`, area: "Guard", title: `package.json "${script.name}" script`, status: "warn", detail: `Runs code that deletes files or downloads and runs programs: ${script.body}` });
      }
    } catch {
      // an unreadable package.json is the project's own business
    }
  }

  return summarizeChecks(checks);
}
