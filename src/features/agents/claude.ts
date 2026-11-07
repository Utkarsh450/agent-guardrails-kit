import type { ReadExisting } from "../../shared/fs-plan.ts";
import { addToStringList, ensureObject, planJsonConfig } from "../../shared/json-config.ts";
import { HOOK_TIMEOUT_SECONDS, claudeDenyRules, commands, matchers } from "./constants.ts";
import { upsertHookGroups, type CommandHook } from "./hook-config.ts";
import type { AgentPlan } from "./types.ts";

export const CLAUDE_SETTINGS = ".claude/settings.json";

/** Claude Code: a PreToolUse hook plus a second layer of permission deny rules in .claude/settings.json. */
export async function planClaude(read: ReadExisting): Promise<AgentPlan> {
  const hook: CommandHook = { type: "command", command: commands.claude, timeout: HOOK_TIMEOUT_SECONDS };
  const file = await planJsonConfig(CLAUDE_SETTINGS, read, (config) => {
    upsertHookGroups(config, "PreToolUse", [
      { matcher: matchers.claude, hooks: [hook] },
      { matcher: matchers.claudeMcp, hooks: [hook] },
    ]);
    const permissions = ensureObject(config, "permissions", "settings");
    addToStringList(permissions, "deny", "permissions", claudeDenyRules);
    return config;
  });

  return {
    agent: "claude",
    enforcement: "enforced",
    files: [file],
    notes: [
      "Claude Code reloads hooks from .claude/settings.json on its own. Run /status to confirm the project settings loaded.",
      "Node must be on PATH for the guard. If it is not, every action is blocked (the hook fails closed) until it is.",
      "Commit .claude/settings.json and .agent-guardrails/guard.mjs so teammates get the same protection.",
    ],
  };
}
