import { AGENT_LABELS } from "../../shared/agents.ts";
import { bucketOf, countBuckets, renderDiff, type Bucket, type PlanGroup, type SetupPlan } from "../setup/index.ts";
import type { Ui } from "./ui.ts";

const SYMBOL: Record<Bucket, string> = { create: "+", update: "~", unchanged: "=", kept: "-", conflict: "!" };
const GROUP_TITLE: Record<PlanGroup, string> = {
  rules: "Rules",
  config: "Settings",
  guard: "Guard",
  agents: "Agent configs",
  git: "Git hooks",
  github: "GitHub files",
};
const GROUP_ORDER: PlanGroup[] = ["rules", "config", "guard", "agents", "git", "github"];

export interface PrintOptions {
  /** Also list files that need no change. */
  showUnchanged?: boolean;
  /** Show what changes inside files that already exist. */
  diffs?: boolean;
}

export function summaryLine(plan: SetupPlan): string {
  const c = countBuckets(plan);
  const parts = [`${c.create} to create`, `${c.update} to update`, `${c.unchanged} already fine`];
  if (c.kept > 0) parts.push(`${c.kept} of yours kept as they are`);
  if (c.conflict > 0) parts.push(`${c.conflict} need attention`);
  return parts.join(", ");
}

/** Prints what the plan would do, grouped, with plain symbols: + create, ~ update, - kept (yours), ! needs attention. */
export function printPlan(ui: Ui, plan: SetupPlan, { showUnchanged = false, diffs = false }: PrintOptions = {}): void {
  ui.print(`Plan: ${summaryLine(plan)}`);
  ui.print("  + create   ~ update   - kept (yours, not touched)   ! needs attention");

  for (const group of GROUP_ORDER) {
    const entries = plan.entries.filter((entry) => entry.group === group && (showUnchanged || bucketOf(entry) !== "unchanged"));
    if (entries.length === 0) continue;
    ui.print("");
    ui.print(GROUP_TITLE[group]);
    for (const entry of entries) {
      const bucket = bucketOf(entry);
      ui.print(`  ${SYMBOL[bucket]} ${entry.file.path}${bucket === "kept" ? "  (your version is kept)" : ""}`);
      if (bucket === "conflict") ui.print(`      ${entry.file.reason ?? "cannot be changed safely"}`);
      if (diffs && bucket === "update") ui.print(renderDiff(entry).split("\n").map((l) => `      ${l}`).join("\n"));
    }
  }

  ui.print("");
  ui.print("Protection by agent");
  for (const { agent, enforcement } of plan.enforcement) {
    ui.print(
      `  ${AGENT_LABELS[agent]}: ${enforcement === "enforced" ? "enforced (a hook blocks dangerous actions)" : "advisory only (rules the agent is asked to follow; no hooks exist)"}`,
    );
  }
  for (const warning of plan.warnings) ui.warn(warning);
  if (plan.stale.length > 0) ui.warn(`These generated files no longer match any rule and can be removed by hand: ${plan.stale.join(", ")}`);
}

/** The steps only the person can do, per agent and for git and GitHub. */
export function printNotes(ui: Ui, plan: SetupPlan, { skipGit = false }: { skipGit?: boolean } = {}): void {
  for (const note of plan.notes) {
    if (skipGit && note.title === "git") continue;
    const title = note.title in AGENT_LABELS ? AGENT_LABELS[note.title as keyof typeof AGENT_LABELS] : note.title;
    ui.note(`Next: ${title}`, note.lines);
  }
}
