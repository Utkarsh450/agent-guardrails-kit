export type RuleScope = "always" | "scoped";

export interface Rule {
  /** File name without extension, unique across both scopes. */
  name: string;
  scope: RuleScope;
  description: string;
  /** Path globs the rule applies to. Only meaningful for scoped rules. */
  globs: string[];
  /** Markdown body with the frontmatter removed, LF line endings. */
  body: string;
  /** Path of the source file, relative to the project root. */
  sourcePath: string;
}

export class RuleError extends Error {
  override name = "RuleError";
}

export const DEFAULT_RULES_DIR = "agent-rules";
