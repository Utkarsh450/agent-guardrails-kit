import type { GuardrailsConfig } from "../../shared/config.ts";
import type { PresetSettings } from "./schema.ts";

export type MergedSettings = Pick<GuardrailsConfig, "policy" | "allowCommands" | "gitAllow" | "approvalGate" | "auditAllowed" | "alwaysRuleFiles" | "checkpoints">;

/** Higher is stricter. "blocklist" lets unknown commands run, "allowlist" blocks all but the listed ones. */
const STRICTNESS = { blocklist: 0, ask: 1, allowlist: 2 } as const;

const squash = (entry: string) => entry.trim().split(/\s+/).join(" ");

/** The project's own entries first, then the preset's new ones. Whitespace differences do not make a new entry. */
function join(base: readonly string[], extra: readonly string[] = []): string[] {
  const seen = new Set(base.map(squash));
  const out = [...base];
  for (const entry of extra) {
    const key = squash(entry);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * Applies a preset to a project's settings. A preset can only keep or raise protection:
 *  - policy: the stricter of the two wins,
 *  - allowCommands and gitAllow: joined, so the project keeps its own entries,
 *  - approvalGate, auditAllowed, alwaysRuleFiles, checkpoints: on wins over off.
 * A setting the preset does not mention is left as it is.
 */
export function mergeSettings(project: GuardrailsConfig, preset: PresetSettings): MergedSettings {
  const policy = preset.policy !== undefined && STRICTNESS[preset.policy] > STRICTNESS[project.policy] ? preset.policy : project.policy;
  return {
    policy,
    allowCommands: join(project.allowCommands, preset.allowCommands),
    gitAllow: join(project.gitAllow, preset.gitAllow),
    approvalGate: project.approvalGate || preset.approvalGate === true,
    auditAllowed: project.auditAllowed || preset.auditAllowed === true,
    alwaysRuleFiles: project.alwaysRuleFiles || preset.alwaysRuleFiles === true,
    checkpoints: project.checkpoints || preset.checkpoints === true,
  };
}

/** True when applying the preset would add or raise something the project does not have yet. */
export function isBehind(project: GuardrailsConfig, preset: PresetSettings): boolean {
  const merged = mergeSettings(project, preset);
  return (
    merged.policy !== project.policy ||
    merged.approvalGate !== project.approvalGate ||
    merged.auditAllowed !== project.auditAllowed ||
    merged.alwaysRuleFiles !== project.alwaysRuleFiles ||
    merged.checkpoints !== project.checkpoints ||
    merged.allowCommands.length !== project.allowCommands.length ||
    merged.gitAllow.length !== project.gitAllow.length
  );
}
