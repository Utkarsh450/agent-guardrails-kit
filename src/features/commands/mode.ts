import { CONFIG_FILE, MODES, WATCH_DEFAULT_DAYS, WATCH_MAX_DAYS, parseConfig } from "../../shared/config.ts";
import { applyPlan } from "../../shared/fs-plan.ts";
import { MergeError, planJsonConfig } from "../../shared/json-config.ts";
import { watchActive } from "../hooks/guard/guard.mjs";
import { diskSyncIo } from "../rules/index.ts";
import { loadSavedConfig, renderDiff } from "../setup/index.ts";
import { CancelledError, CliError } from "./errors.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";

export interface ModeOptions {
  /** How long watch mode lasts. */
  days?: number;
  yes?: boolean;
  /** The current time; tests pass a fixed one. */
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `agent-guardrails mode [watch|enforce]`: with no argument, says which mode the guard is in.
 * `mode watch` lets actions the guard would ASK about run (and logs them) for a limited number of days.
 * Blocked actions stay blocked. Only a person should run this: the guard stops agents from running it.
 */
export async function runMode(ctx: CommandContext, name?: string, options: ModeOptions = {}): Promise<number> {
  const { ui } = ctx;
  const now = options.now ?? new Date();
  const root = findProjectRoot(ctx.cwd);
  const io = diskSyncIo(root);
  const saved = await loadSavedConfig(io);
  if (saved === null) throw new CliError("No saved settings found. Run `agent-guardrails init` first.");

  if (name === undefined) {
    if (saved.mode === "watch" && watchActive(saved, now)) {
      ui.warn(`Watch mode is ON until ${saved.watchUntil}. Actions the guard would ask about run and are logged. Blocked actions are still blocked.`);
      ui.print("Switch it off now with: agent-guardrails mode enforce");
    } else if (saved.mode === "watch") {
      ui.info('The settings say "watch" but there is no valid end date within the next 30 days, so the guard is enforcing.');
    } else {
      ui.success("The guard is enforcing: it asks and blocks as normal.");
    }
    return 0;
  }

  if (!(MODES as readonly string[]).includes(name)) throw new CliError(`Unknown mode "${name}". Choose from ${MODES.join(", ")}.`);

  let changes: { mode: "enforce" | "watch"; watchUntil: string | null };
  if (name === "watch") {
    const days = options.days ?? WATCH_DEFAULT_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > WATCH_MAX_DAYS) {
      throw new CliError(`--days must be a whole number from 1 to ${WATCH_MAX_DAYS}.`);
    }
    changes = { mode: "watch", watchUntil: new Date(now.getTime() + days * DAY_MS).toISOString() };
  } else {
    changes = { mode: "enforce", watchUntil: null };
  }

  const plan = await planJsonConfig(CONFIG_FILE, io.readExisting, (config) => {
    const next = { ...config, ...changes };
    try {
      parseConfig(JSON.stringify(next));
    } catch (error) {
      throw new MergeError(error instanceof Error ? error.message : String(error));
    }
    return next;
  });
  if (plan.status === "conflict") throw new CliError(`Could not change ${CONFIG_FILE}: ${plan.reason}`);
  if (plan.status === "unchanged") {
    ui.success(`Already in ${name} mode.`);
    return 0;
  }

  ui.print(renderDiff({ group: "config", file: plan }));
  if (name === "watch") {
    ui.warn(
      `Until ${changes.watchUntil}, actions the guard would ASK about run without asking and are logged. ` +
        "Blocked actions (deleting files, changing git, secrets, anything outside the folder) stay blocked, " +
        "and so do changes to rule files and MCP tools that act on outside systems. Watch mode ends by itself.",
    );
  }
  if (!options.yes) {
    if (!ui.interactive) throw new CliError("Run again with --yes to apply this change.");
    if (!(await ui.confirm({ message: name === "watch" ? "Turn watch mode on?" : "Switch back to enforcing?", initial: false }))) throw new CancelledError();
  }
  await applyPlan(root, [plan]);
  ui.success(name === "watch" ? "Watch mode is on. See what it let through with `agent-guardrails report`." : "The guard is enforcing again.");
  return 0;
}
