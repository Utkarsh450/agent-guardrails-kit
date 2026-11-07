import { createHash } from "node:crypto";
import type { PresetSettings } from "./schema.ts";

const normalize = (list: readonly string[] | undefined) => (list === undefined ? undefined : [...new Set(list.map((item) => item.trim().split(/\s+/).join(" ")))].sort());

/**
 * A fingerprint of what a preset asks for. The order of list entries does not matter, so reordering a preset does not
 * count as a change.
 */
export function presetHash(settings: PresetSettings): string {
  const canonical = {
    policy: settings.policy,
    allowCommands: normalize(settings.allowCommands),
    gitAllow: normalize(settings.gitAllow),
    approvalGate: settings.approvalGate,
    auditAllowed: settings.auditAllowed,
    alwaysRuleFiles: settings.alwaysRuleFiles,
    checkpoints: settings.checkpoints,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
