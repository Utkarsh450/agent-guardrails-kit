import { antigravityPermissions } from "./constants.ts";
import type { AgentPlan } from "./types.ts";

export const ANTIGRAVITY_USER_SETTINGS = "~/.gemini/antigravity-cli/settings.json";

/** The text the user pastes into their Antigravity CLI settings (it lives outside the project). */
export function antigravityPermissionsSnippet(): string {
  return JSON.stringify(antigravityPermissions, null, 2);
}

/**
 * Antigravity has no hook mechanism, so the project side is rules only (AGENTS.md, GEMINI.md, scoped rules).
 * Its permission rules live in the user's home folder, which the kit never writes to, so it hands the user a snippet.
 */
export function planAntigravity(): AgentPlan {
  return {
    agent: "antigravity",
    enforcement: "advisory",
    files: [],
    notes: [
      "Antigravity has no hooks, so nothing here can block an action. The rules are only instructions the agent is asked to follow.",
      `Add deny and allow rules yourself in ${ANTIGRAVITY_USER_SETTINGS} (the kit never writes outside the project). Run \`agent-guardrails-kit explain antigravity\` to see the suggested contents.`,
      "Antigravity matches command rules by prefix and turns prefix matching off for compound commands, so these rules are a weak layer. Keep Terminal Command Auto Execution on 'Request Review' in the IDE settings, and turn on terminal sandboxing if your version offers it.",
      "Antigravity truncates any rule file over 24,000 bytes; `agent-guardrails-kit sync` warns if AGENTS.md gets that big.",
    ],
  };
}
