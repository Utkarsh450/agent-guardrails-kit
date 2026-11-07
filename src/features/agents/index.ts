export { detectAgents, type Detected } from "./detect.ts";
export { ENFORCEMENT, planAgents } from "./plan.ts";
export { planClaude, CLAUDE_SETTINGS } from "./claude.ts";
export { planCursor, CURSOR_HOOKS } from "./cursor.ts";
export { planCodex, CODEX_HOOKS } from "./codex.ts";
export { planQoder, QODER_SETTINGS } from "./qoder.ts";
export { planAntigravity, antigravityPermissionsSnippet, ANTIGRAVITY_USER_SETTINGS } from "./antigravity.ts";
export { commands, matchers, GUARD_PATH, GUARD_MARKER, HOOK_TIMEOUT_SECONDS } from "./constants.ts";
export type { AgentPlan, Enforcement } from "./types.ts";
