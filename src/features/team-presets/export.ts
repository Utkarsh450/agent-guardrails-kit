import type { GuardrailsConfig } from "../../shared/config.ts";
import { PRESET_KIND, PresetError, parsePresetFile, type PresetFile } from "./schema.ts";
import { checkAllowCommands } from "./validate.ts";

/**
 * Builds a preset from a project's current settings. It refuses a project whose settings a preset cannot carry
 * (a "blocklist" policy, the plan gate off, a git command that is not read-only, an allowed command that is too broad),
 * so a file made here is always accepted by `preset use` elsewhere.
 */
export function buildPresetFromConfig(config: GuardrailsConfig, name: string, description?: string): PresetFile {
  if (config.policy === "blocklist") {
    throw new PresetError('The project uses policy "blocklist" (unknown commands run without asking), which a preset cannot carry. Change it to "ask" first.');
  }
  if (!config.approvalGate) {
    throw new PresetError('The project has the plan gate off ("approvalGate": false), which a preset cannot carry. Turn it on first.');
  }
  const problems = checkAllowCommands(config.allowCommands);
  if (problems.length > 0) {
    throw new PresetError(`These allowed commands cannot go into a preset: ${problems.map((p) => `"${p.entry}" ${p.reason}`).join("; ")}.`);
  }
  const candidate = {
    kind: PRESET_KIND,
    version: 1,
    name,
    ...(description !== undefined && description !== "" ? { description } : {}),
    settings: {
      policy: config.policy,
      allowCommands: config.allowCommands,
      gitAllow: config.gitAllow,
      approvalGate: true,
      auditAllowed: config.auditAllowed,
      alwaysRuleFiles: config.alwaysRuleFiles,
      checkpoints: config.checkpoints,
    },
  };
  // Run it through the same reader a project will use, so a bad value is caught here and not on the other side.
  return parsePresetFile(JSON.stringify(candidate));
}

export const serializePreset = (preset: PresetFile): string => `${JSON.stringify(preset, null, 2)}\n`;
