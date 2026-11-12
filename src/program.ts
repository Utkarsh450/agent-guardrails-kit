import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { bigBanner, plainBanner } from "./features/commands/banner.ts";
import { runAlerts } from "./features/commands/alerts.ts";
import { runCheckpoints } from "./features/commands/checkpoints.ts";
import { runRestore } from "./features/commands/restore.ts";
import { runAllowAdd, runAllowList, runAllowRemove } from "./features/commands/allow.ts";
import { runApprove } from "./features/commands/approve.ts";
import type { CommandContext } from "./features/commands/context.ts";
import { runDashboard } from "./features/commands/dashboard.ts";
import { runDoctor } from "./features/commands/doctor.ts";
import { CancelledError, CliError } from "./features/commands/errors.ts";
import { runExplain } from "./features/commands/explain.ts";
import { runInit } from "./features/commands/init.ts";
import { runMode } from "./features/commands/mode.ts";
import { runPreset } from "./features/commands/preset.ts";
import { runReport } from "./features/commands/report.ts";
import { runSync } from "./features/commands/sync.ts";
import { runTest } from "./features/commands/test.ts";
import { terminalUi, type Ui } from "./features/commands/ui.ts";
import { runUpdate } from "./features/commands/update.ts";

export interface ProgramDeps {
  /** Creates the Ui for one command run. Tests pass a scripted one. */
  makeUi: () => Ui;
  /** Records the process exit code. */
  setExitCode: (code: number) => void;
  /** The folder commands work on unless --cwd is given. */
  defaultCwd: () => string;
}

export function defaultDeps(): ProgramDeps {
  return {
    makeUi: terminalUi,
    setExitCode: (code) => {
      process.exitCode = code;
    },
    defaultCwd: () => process.cwd(),
  };
}

/** Turns an error into a short message and an exit code. Stack traces only with AGENT_GUARDRAILS_DEBUG=1. */
export function reportError(ui: Ui, error: unknown): number {
  if (error instanceof CancelledError) {
    ui.warn(error.message);
    return 130;
  }
  if (error instanceof CliError) {
    ui.error(error.message);
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  ui.error(`Something went wrong: ${message}`);
  if (process.env.AGENT_GUARDRAILS_DEBUG === "1" && error instanceof Error && error.stack) ui.print(error.stack);
  return 1;
}

/**
 * Builds the CLI. Each command is a thin layer over a function in src/features/commands, so everything the
 * commands do can also be tested without a terminal.
 */
export function buildProgram(deps: ProgramDeps = defaultDeps()): Command {
  const program = new Command();

  program
    .name("agent-guardrails-kit")
    .description("Set up safe, shared rules, hooks and git guardrails for AI coding agents (Claude Code, Cursor, Codex, Antigravity, Qoder).")
    .version(pkg.version, "-v, --version", "print the version")
    .option("--cwd <folder>", "work on this project folder instead of the current one")
    .showHelpAfterError("(run with --help to see the options)")
    .addHelpText("beforeAll", () =>
      process.stdout.isTTY ? `${bigBanner({ colour: true, columns: process.stdout.columns ?? 80 })}\n` : `${plainBanner()}\n`,
    )
    .addHelpText(
      "after",
      `
Quick start
  agent-guardrails-kit init            choose your agents and set everything up (asks before writing)
  agent-guardrails-kit doctor          check what works and what does not
  agent-guardrails-kit test --hooks    prove the guard blocks what it should
  agent-guardrails-kit explain         why was something blocked?

Nothing is created or changed without showing you the plan first, and nothing is ever deleted.`,
    );

  /** Wraps a command so errors become messages and the exit code is set. */
  const command = (name: string, description: string): Command => program.command(name).description(description);
  const run =
    (fn: (ctx: CommandContext) => Promise<number> | number) =>
    async (): Promise<void> => {
      const ui = deps.makeUi();
      const cwd = program.opts<{ cwd?: string }>().cwd ?? deps.defaultCwd();
      try {
        deps.setExitCode(await fn({ cwd, ui }));
      } catch (error) {
        deps.setExitCode(reportError(ui, error));
      }
    };

  command("init", "Set up guardrails in this project: rules, hooks, git checks and GitHub files")
    .option("--agents <list>", 'agents to set up: claude, cursor, codex, antigravity, qoder (comma separated) or "all"')
    .option("--preset <name>", "learner, balanced (default), team or light")
    .option("--stack <name>", "generic, node-ts, python, go or db-heavy (detected if omitted)")
    .option("--no-github", "do not add GitHub templates, CODEOWNERS or the CI workflow")
    .option("-y, --yes", "apply the plan without asking (nothing is ever written without --yes or an answer)")
    .option("--dry-run", "show the plan and write nothing")
    .option("--git-config", "also run `git config core.hooksPath .githooks` in this project")
    .option("--no-git-config", "never touch git config")
    .option("--diff", "show what changes inside existing files")
    .action(async (options) => run((ctx) => runInit(ctx, options))());

  command("update", "Refresh the generated files from this version of the kit, using your saved settings")
    .option("-y, --yes", "apply without asking")
    .option("--dry-run", "show what would change and write nothing")
    .option("--git-config", "also run `git config core.hooksPath .githooks`")
    .option("--no-git-config", "never touch git config")
    .option("--diff", "show what changes inside existing files")
    .action(async (options) => run((ctx) => runUpdate(ctx, options))());

  command("doctor", "Check the setup: what is protected, what is advisory only, what is missing or out of date")
    .option("--ci", "plain output for CI (the exit code is 1 when there is a problem)")
    .option("--json", "print the result as JSON")
    .option("--strict", "treat warnings as problems")
    .option("--check-user-settings", "also read ~/.gemini/antigravity-cli/settings.json to check Antigravity's permission rules")
    .action(async (options) => run((ctx) => runDoctor(ctx, options))());

  command("sync", "Regenerate AGENTS.md, CLAUDE.md and the per-agent rule files from agent-rules/")
    .option("--check", "write nothing; exit 1 if anything is out of date (for CI)")
    .option("-y, --yes", "write without asking")
    .option("--dry-run", "show what would change and write nothing")
    .action(async (options) => run((ctx) => runSync(ctx, options))());

  command("approve", "Approve the plan (PLAN.md) the agent wrote, so it may start changing files")
    .option("-y, --yes", "approve without asking")
    .option("--status", "only say whether a plan is approved (exit code 0 if it is)")
    .option("--revoke", "withdraw the current approval")
    .action(async (options) => run((ctx) => runApprove(ctx, options))());

  command("report", "Show what the agents tried: blocked and asked actions from the local audit log")
    .option("--limit <n>", "how many recent actions to list", (value) => Number.parseInt(value, 10), 10)
    .option("--json", "print the result as JSON")
    .action(async (options) => run((ctx) => runReport(ctx, options))());

  command("alerts", "Follow blocked and asked actions live in a spare terminal tab (Ctrl+C to stop)")
    .option("--notify", "also show a desktop notification (macOS and Linux)")
    .option("--detail", "put the command text in the notification (default: only the agent and the rule)")
    .option("--all", "also show allowed actions (only logged when auditAllowed is on)")
    .action(async (options) => run((ctx) => runAlerts(ctx, options))());

  const allow = command("allow", "Choose commands that run without asking");
  allow
    .command("list")
    .description("show the commands that run without asking")
    .action(async () => run((ctx) => runAllowList(ctx))());
  allow
    .command("add <command>")
    .description('let a command (and anything starting with it) run without asking, for example "pnpm test"')
    .option("-y, --yes", "add without asking")
    .action(async (pattern: string, options) => run((ctx) => runAllowAdd(ctx, pattern, options))());
  allow
    .command("remove <command>")
    .description("ask about a command again")
    .option("-y, --yes", "remove without asking")
    .action(async (pattern: string, options) => run((ctx) => runAllowRemove(ctx, pattern, options))());

  command("preset <name> [target]", "Switch the guard settings to a preset: learner, balanced, team or light. Or share one: 'export [file]' and 'use <file or package>'")
    .option("--stack <name>", "also change the project kind")
    .option("--name <text>", "name written into an exported preset")
    .option("--description <text>", "description written into an exported preset")
    .option("-y, --yes", "apply without asking")
    .option("--dry-run", "show the change and write nothing")
    .action(async (name: string, target: string | undefined, options) => run((ctx) => runPreset(ctx, name, { ...options, target }))());

  command("mode [name]", "Show or change the mode: watch (log asks for a few days, blocks stay) or enforce")
    .option("--days <n>", "how long watch mode lasts, 1 to 30 (default 7)", (value) => Number.parseInt(value, 10))
    .option("-y, --yes", "apply without asking")
    .action(async (name: string | undefined, options) => run((ctx) => runMode(ctx, name, options))());

  command("checkpoints [id]", "List the file copies saved before agents changed files, or show what one holds")
    .option("--limit <n>", "how many to list (default 20)", (value) => Number.parseInt(value, 10))
    .action(async (id: string | undefined, options) => run((ctx) => runCheckpoints(ctx, id, options))());

  command("restore <id>", "Put back the files a checkpoint saved (shows a diff and asks first; never deletes)")
    .option("--file <path>", "restore only this file")
    .option("-y, --yes", "restore without asking")
    .action(async (id: string, options) => run((ctx) => runRestore(ctx, id, options))());

  command("explain [name]", "Say in plain words why the guard blocked or asked, or what an agent or topic means")
    .action(async (name?: string) => run((ctx) => runExplain(ctx, name))());

  command("test", "Prove the guard works, or print a prompt to test an agent for real")
    .option("--hooks", "run the guard self-test (the default)")
    .option("--prompt", "print a prompt to paste into a fresh agent session in a throwaway copy of the project")
    .option("--gap-review", "print a read-only prompt asking an agent what could still go wrong")
    .option("--agent <name>", "which agent the prompt is for")
    .option("--full", "run every case against the installed guard (slow)")
    .action(async (options) => run((ctx) => runTest(ctx, options))());

  command("ui", "Open a read-only dashboard in your browser: doctor report, setup plan, activity and test prompts")
    .option("--port <n>", "port to listen on (default 4747; 0 picks a free one)", (value) => Number.parseInt(value, 10))
    .option("--open", "open the dashboard in your default browser")
    .action(async (options) => run((ctx) => runDashboard(ctx, options))());

  return program;
}
