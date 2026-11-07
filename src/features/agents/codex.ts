import type { ReadExisting } from "../../shared/fs-plan.ts";
import { planJsonConfig } from "../../shared/json-config.ts";
import { HOOK_TIMEOUT_SECONDS, commands, matchers } from "./constants.ts";
import { upsertHookGroups } from "./hook-config.ts";
import type { AgentPlan } from "./types.ts";

export const CODEX_HOOKS = ".codex/hooks.json";

/**
 * Codex: a PreToolUse hook for shell commands, patches and MCP tools.
 * Codex hooks can only deny or stay silent (an "ask" answer makes the hook fail and the call continue),
 * so the guard turns every "ask" into a deny that tells the agent to ask you in chat.
 */
export async function planCodex(read: ReadExisting): Promise<AgentPlan> {
  const file = await planJsonConfig(CODEX_HOOKS, read, (config) => {
    upsertHookGroups(config, "PreToolUse", [
      {
        matcher: matchers.codex,
        hooks: [
          {
            type: "command",
            command: commands.codex,
            timeout: HOOK_TIMEOUT_SECONDS,
            statusMessage: "agent-guardrails: checking this action",
          },
        ],
      },
    ]);
    return config;
  });

  return {
    agent: "codex",
    enforcement: "enforced",
    files: [file],
    notes: [
      "Codex only loads project hooks after you trust them: open Codex in this project, run /hooks, and trust the agent-guardrails hook.",
      "Trust is tied to the hook's definition, so run /hooks again after `agent-guardrails update` changes .codex/hooks.json.",
      "Codex cannot ask you about unknown commands; the guard denies them and tells the agent to ask you in chat.",
      "Strongly recommended, in ~/.codex/config.toml or .codex/config.toml (check the key names against the current Codex docs): approval_policy = \"on-request\" and sandbox_mode = \"workspace-write\". The sandbox blocks writes outside the project even if a command slips past the guard.",
    ],
  };
}
