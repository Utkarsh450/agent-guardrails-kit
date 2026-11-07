import path from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import { AGENT_IDS, AGENT_LABELS, type AgentId } from "../../shared/agents.ts";
import { formatDoctor, gatherDoctor } from "../commands/doctor.ts";
import { ENFORCEMENT, detectAgents } from "../agents/index.ts";
import { RULES, listExplainable } from "../explain/index.ts";
import { loadAuditReport } from "../hooks/index.ts";
import { detectPackageManager } from "../package-manager/index.ts";
import { detectStack } from "../presets/index.ts";
import { gapReviewPrompt, testGuardrailsPrompt } from "../prompts/index.ts";
import { diskSyncIo } from "../rules/index.ts";
import { bucketOf, buildSetupPlan, countBuckets, loadSavedConfig, readHooksPath, renderDiff, type SetupOptions } from "../setup/index.ts";

/**
 * Everything the dashboard shows is computed here from the project on disk, fresh on every request.
 * Nothing in this file writes anything.
 */

export interface Overview {
  tool: { name: string; version: string };
  project: { folder: string; configured: boolean };
  settings: { preset: string; stack: string; policy: string; approvalGate: boolean; allowedCommands: number; agents: AgentId[] } | null;
  protection: Array<{ agent: AgentId; label: string; enforcement: "enforced" | "advisory"; configured: boolean }>;
  doctor: Awaited<ReturnType<typeof gatherDoctor>>;
}

export async function overview(root: string): Promise<Overview> {
  const io = diskSyncIo(root);
  const saved = await loadSavedConfig(io);
  const doctor = await gatherDoctor(root);
  const configured = new Set<AgentId>(saved?.agents ?? []);
  return {
    tool: { name: pkg.name, version: pkg.version },
    project: { folder: path.basename(root), configured: saved !== null },
    settings: saved
      ? { preset: saved.preset, stack: saved.stack, policy: saved.policy, approvalGate: saved.approvalGate, allowedCommands: saved.allowCommands.length, agents: saved.agents }
      : null,
    protection: AGENT_IDS.map((agent) => ({ agent, label: AGENT_LABELS[agent], enforcement: ENFORCEMENT[agent], configured: configured.has(agent) })),
    doctor,
  };
}

/** What `init` (or `update`, when set up) would do to this project. Read only: nothing is applied. */
export async function planPreview(root: string) {
  const io = diskSyncIo(root);
  const saved = await loadSavedConfig(io);
  const manager = await detectPackageManager(io.readExisting);
  const detected = await detectAgents(io.readExisting);
  const stack = await detectStack(io.readExisting);

  const options: SetupOptions = saved
    ? { agents: saved.agents, preset: saved.preset, stack: saved.stack, packageManager: manager.manager, github: saved.github }
    : { agents: detected.length > 0 ? detected.map((d) => d.agent) : ["claude"], preset: "balanced", stack: stack.stack, packageManager: manager.manager, github: true };

  const isRepo = (await io.readExisting(".git")) !== null;
  const plan = await buildSetupPlan({ options, io, hooksPathSet: isRepo ? readHooksPath(root) : null, createMissingRules: saved === null });
  return {
    basedOn: saved ? "your saved settings (this is what `update` would do)" : "the defaults it would suggest (this is what `init` would do)",
    options,
    counts: countBuckets(plan),
    entries: plan.entries.map((entry) => ({
      group: entry.group,
      path: entry.file.path,
      status: bucketOf(entry),
      reason: entry.file.reason,
      diff: entry.file.status === "update" ? renderDiff(entry) : null,
    })),
    notes: plan.notes,
    warnings: plan.warnings,
    stale: plan.stale,
    enforcement: plan.enforcement,
    git: plan.git,
  };
}

export async function activity(root: string, limit = 25) {
  const report = await loadAuditReport(root, Math.min(Math.max(limit, 1), 100));
  return { ...report, titles: Object.fromEntries(Object.entries(RULES).map(([id, info]) => [id, info.title])) };
}

export async function prompts(root: string) {
  const doctorText = formatDoctor(await gatherDoctor(root));
  return {
    agents: AGENT_IDS.map((id) => ({ id, label: AGENT_LABELS[id], enforcement: ENFORCEMENT[id] })),
    test: Object.fromEntries(AGENT_IDS.map((id) => [id, testGuardrailsPrompt(id)])),
    gapReview: gapReviewPrompt(doctorText),
    howTo: [
      "Make a throwaway copy of your project with no git remotes and no real credentials. Never test in your real working copy.",
      "Open a FRESH session of your AI agent in that copy and paste the prompt.",
      "Answer NO to every permission question. The agent reports what was blocked, asked or allowed.",
    ],
  };
}

export function explainIndex() {
  const all = listExplainable();
  return {
    rules: all.rules.map((id) => ({ id, title: RULES[id]?.title ?? id, kind: RULES[id]?.kind ?? "info" })),
    topics: all.topics,
    agents: all.agents,
  };
}
