import type { ReadExisting } from "../../shared/fs-plan.ts";
import { addToStringList, ensureObject, planJsonConfig } from "../../shared/json-config.ts";
import { HOOK_TIMEOUT_SECONDS, commands, matchers, qoderDenyRules } from "./constants.ts";
import { upsertHookGroups, type CommandHook } from "./hook-config.ts";
import type { AgentPlan } from "./types.ts";

export const QODER_SETTINGS = ".qoder/settings.json";

/** Qoder CLI: Claude-style PreToolUse hooks and permission deny rules in .qoder/settings.json. */
export async function planQoder(read: ReadExisting): Promise<AgentPlan> {
  const hook: CommandHook = { type: "command", command: commands.qoder, timeout: HOOK_TIMEOUT_SECONDS };
  const file = await planJsonConfig(QODER_SETTINGS, read, (config) => {
    upsertHookGroups(config, "PreToolUse", [
      { matcher: matchers.qoder, hooks: [hook] },
      { matcher: matchers.qoderMcp, hooks: [hook] },
    ]);
    const permissions = ensureObject(config, "permissions", "settings");
    addToStringList(permissions, "deny", "permissions", qoderDenyRules);
    return config;
  });

  return {
    agent: "qoder",
    enforcement: "enforced",
    files: [file],
    notes: [
      "Qoder CLI loads hooks from .qoder/settings.json. These checks apply to the Qoder CLI; the Qoder desktop IDE uses its own settings, so also review its permission settings.",
      "Qoder reads AGENTS.md itself, so only scoped rules are written to .qoder/rules.",
    ],
  };
}
