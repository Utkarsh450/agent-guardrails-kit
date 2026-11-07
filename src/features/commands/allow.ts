import { CONFIG_FILE, type GuardrailsConfig } from "../../shared/config.ts";
import { applyPlan } from "../../shared/fs-plan.ts";
import { planJsonConfig } from "../../shared/json-config.ts";
import { evaluate, normalizeRequest } from "../hooks/guard/guard.mjs";
import { makeContext } from "../hooks/sandbox.ts";
import { ruleInfo } from "../explain/index.ts";
import { BROAD_PROGRAMS } from "../presets/index.ts";
import { diskSyncIo } from "../rules/index.ts";
import { loadSavedConfig } from "../setup/index.ts";
import { CancelledError, CliError } from "./errors.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";

export interface AllowOptions {
  yes?: boolean;
}

/** Programs that run whatever script they are given: allowing them bare allows nearly anything. */
const BROAD = BROAD_PROGRAMS;

const normalize = (pattern: string) => pattern.trim().split(/\s+/).join(" ");

async function load(ctx: CommandContext): Promise<{ root: string; saved: GuardrailsConfig }> {
  const root = findProjectRoot(ctx.cwd);
  const saved = await loadSavedConfig(diskSyncIo(root));
  if (saved === null) throw new CliError(`No valid settings found. Run \`agent-guardrails init\` first (${CONFIG_FILE} is missing or invalid).`);
  return { root, saved };
}

async function save(root: string, transform: (list: string[]) => string[]): Promise<void> {
  const io = diskSyncIo(root);
  const plan = await planJsonConfig(CONFIG_FILE, io.readExisting, (config) => {
    const current = Array.isArray(config.allowCommands) ? (config.allowCommands as unknown[]).filter((x): x is string => typeof x === "string") : [];
    return { ...config, allowCommands: transform(current) };
  });
  if (plan.status === "conflict") throw new CliError(`Could not update ${CONFIG_FILE}: ${plan.reason}`);
  await applyPlan(root, [plan]);
}

/** `agent-guardrails allow list` */
export async function runAllowList(ctx: CommandContext): Promise<number> {
  const { saved } = await load(ctx);
  if (saved.allowCommands.length === 0) {
    ctx.ui.info('No commands are allowed to run without asking. Add one with: agent-guardrails allow add "pnpm test"');
    return 0;
  }
  ctx.ui.print("These commands run without asking (any arguments may follow them):");
  for (const pattern of saved.allowCommands) ctx.ui.print(`  ${pattern}`);
  return 0;
}

/** `agent-guardrails allow add "<command>"`: stop asking about a command you trust. */
export async function runAllowAdd(ctx: CommandContext, rawPattern: string, options: AllowOptions = {}): Promise<number> {
  const { ui } = ctx;
  const { root, saved } = await load(ctx);
  const pattern = normalize(rawPattern);
  if (pattern === "") throw new CliError('Say which command to allow, for example: agent-guardrails allow add "pnpm test"');
  if (pattern.split(" ")[0] === "*") throw new CliError('An entry must start with a command name, not "*". Allowing everything would switch the guard off.');
  if (saved.allowCommands.includes(pattern)) {
    ui.info(`"${pattern}" is already allowed.`);
    return 0;
  }

  // Ask the real guard what would happen if this were allowed.
  const probe = makeContext({ config: { ...saved, allowCommands: [pattern] } });
  const result = evaluate(normalizeRequest({ tool_name: "Bash", tool_input: { command: pattern }, cwd: "/proj" }), probe);
  const why = ruleInfo(result.rule);
  if (result.decision === "deny") {
    throw new CliError(`"${pattern}" is always blocked (${result.rule}: ${why?.title ?? "see agent-guardrails explain " + result.rule}), so allowing it would do nothing. Run it yourself.`);
  }
  if (result.decision === "ask") {
    throw new CliError(`"${pattern}" would still ask (${result.rule}: ${why?.title ?? result.reason}). This kind of command cannot be allowed in advance. Run \`agent-guardrails explain ${result.rule}\` for why.`);
  }
  if (result.rule === "allowed") {
    ui.info(`"${pattern}" already runs without asking (the guard knows it is harmless), so nothing was added.`);
    return 0;
  }

  const first = pattern.split(" ")[0] ?? "";
  if (pattern.split(" ").length === 1 && BROAD.has(first)) {
    ui.warn(`"${pattern}" lets an agent run ANY ${first} script or arguments without asking. Prefer something narrower, for example "${first} scripts/build.mjs".`);
    if (!options.yes) {
      if (!ui.interactive) throw new CliError("Run again with --yes if you really want this.");
      if (!(await ui.confirm({ message: `Allow "${pattern}" anyway?`, initial: false }))) throw new CancelledError();
    }
  } else if (!options.yes) {
    if (!ui.interactive) throw new CliError("Run again with --yes to add it.");
    if (!(await ui.confirm({ message: `Let "${pattern}" (and anything starting with it) run without asking?`, initial: true }))) throw new CancelledError();
  }

  await save(root, (list) => [...list, pattern]);
  ui.success(`Added "${pattern}". The guard still blocks dangerous parts of any command that contains it.`);
  return 0;
}

/** `agent-guardrails allow remove "<command>"` */
export async function runAllowRemove(ctx: CommandContext, rawPattern: string, options: AllowOptions = {}): Promise<number> {
  const { ui } = ctx;
  const { root, saved } = await load(ctx);
  const pattern = normalize(rawPattern);
  if (!saved.allowCommands.includes(pattern)) {
    throw new CliError(`"${pattern}" is not on the list. Current entries: ${saved.allowCommands.length > 0 ? saved.allowCommands.join(", ") : "(none)"}.`);
  }
  if (!options.yes) {
    if (!ui.interactive) throw new CliError("Run again with --yes to remove it.");
    if (!(await ui.confirm({ message: `Ask about "${pattern}" again?`, initial: true }))) throw new CancelledError();
  }
  await save(root, (list) => list.filter((entry) => entry !== pattern));
  ui.success(`Removed "${pattern}". The guard will ask about it again.`);
  return 0;
}
