export { parseRule } from "./parse.ts";
export { renderAgentRule, renderAgentsMd, renderClaudeMd, renderGeminiMd, type RuleTarget } from "./render.ts";
export {
  ANTIGRAVITY_MAX_FILE_BYTES,
  applySync,
  desiredFiles,
  diskSyncIo,
  loadRules,
  planSync,
  type SyncIo,
  type SyncOptions,
  type SyncPlan,
} from "./sync.ts";
export { defaultRuleSources, type RuleSourceFile } from "./templates/index.ts";
export { DEFAULT_RULES_DIR, RuleError, type Rule, type RuleScope } from "./types.ts";
