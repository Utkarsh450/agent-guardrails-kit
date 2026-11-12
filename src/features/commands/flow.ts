import { applySetup, countBuckets, renderDiff, setHooksPath, type SetupPlan } from "../setup/index.ts";
import { CancelledError, CliError } from "./errors.ts";
import { printNotes, printPlan } from "./render.ts";
import type { Ui } from "./ui.ts";

export interface FlowOptions {
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
  /** Run `git config core.hooksPath .githooks`. undefined = ask (or skip when there is nobody to ask). */
  gitConfig?: boolean | undefined;
  diff?: boolean | undefined;
  /** What to call things in messages. */
  verb: "init" | "update";
}

/**
 * Shows the plan, gets the person's approval, writes the files, and (with their say-so) turns on the git hooks.
 * Returns the number of files written. Nothing is written before approval.
 */
export async function reviewAndApply(ui: Ui, root: string, plan: SetupPlan, options: FlowOptions): Promise<number> {
  const counts = countBuckets(plan);
  const changes = counts.create + counts.update;

  printPlan(ui, plan, { showUnchanged: options.verb === "init" && changes === 0, diffs: options.diff === true });
  ui.print("");

  if (options.dryRun) {
    ui.outro("Dry run: nothing was written.");
    return 0;
  }

  let hooksSet = plan.git.hooksPathSet === true;

  if (changes > 0) {
    if (!options.yes) {
      if (!ui.interactive) {
        throw new CliError("This would change files. Read the plan above, then run again with --yes to apply it (or --dry-run to only look).");
      }
      for (;;) {
        const choice = await ui.select<"apply" | "details" | "cancel">({
          message: "What next?",
          choices: [
            { value: "apply", label: "Apply these changes" },
            // With no existing file to compare, this choice would print nothing and ask again, which looks like a broken prompt.
            ...(counts.update > 0 ? [{ value: "details" as const, label: "Show what changes inside existing files first" }] : []),
            { value: "cancel", label: "Cancel (nothing is changed)" },
          ],
          initial: "apply",
        });
        if (choice === "cancel") throw new CancelledError();
        if (choice === "apply") break;
        for (const entry of plan.entries.filter((e) => e.file.status === "update")) {
          ui.print(`\n${entry.file.path}\n${renderDiff(entry)}`);
        }
      }
    }
    if (counts.conflict > 0) ui.warn(`${counts.conflict} file(s) cannot be changed safely and are left exactly as they are. See the "!" lines above.`);
    const written = await applySetup(root, plan);
    ui.success(`Wrote ${written.length} file(s).`);
  } else {
    ui.success(options.verb === "update" ? "Everything is up to date." : "Everything is already set up.");
  }

  // The git hooks only run after one setting in the clone. The person running the CLI may turn it on.
  if (plan.git.isRepo && plan.git.hooksPathSet !== true) {
    let doIt = options.gitConfig === true;
    if (options.gitConfig === undefined && ui.interactive && !options.yes) {
      doIt = await ui.confirm({ message: `Turn the git hooks on now? This runs: ${plan.git.command}`, initial: true });
    }
    if (doIt) {
      const result = setHooksPath(root);
      if (result.ok) {
        hooksSet = true;
        ui.success(`Ran: ${result.message}`);
      } else {
        ui.warn(`Could not turn the git hooks on (${result.message}). Run it yourself: ${plan.git.command}`);
      }
    }
  }

  printNotes(ui, plan, { skipGit: hooksSet });
  return changes;
}
