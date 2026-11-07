import type { GuardConfig } from "../guard/guard.mjs";

/**
 * What the guard must do with a case, whatever the project's policy:
 *  - deny: always blocked (also by the allow list and every policy)
 *  - allow: runs without asking (known read-only)
 *  - gated: never runs silently (asks or denies)
 *  - not-deny: may ask or run, but must not be blocked outright
 */
export type Expectation = "deny" | "allow" | "gated" | "not-deny";

export interface CorpusCase {
  /** Shell command for the Bash tool. Use `payload` instead for other tools. */
  command?: string;
  /** Raw hook payload. "{{ROOT}}" is replaced by the project root. */
  payload?: unknown;
  expect: Expectation;
  /** For deny cases: the rule that must fire. */
  rule?: string;
  /** Treat the plan as human-approved. */
  approved?: boolean;
  /** Config overrides for this case. */
  config?: Partial<GuardConfig>;
  /** Extra project files (path relative to the root). */
  files?: Record<string, string>;
  /** Also run under permissive configs (policy "blocklist", everything allow-listed) and require the same outcome. */
  stress?: boolean;
  note?: string;
}

export function denyAll(rule: string, commands: readonly string[]): CorpusCase[] {
  return commands.map((command) => ({ command, expect: "deny", rule }));
}
export function allowAll(commands: readonly string[]): CorpusCase[] {
  return commands.map((command) => ({ command, expect: "allow" }));
}
export function gatedAll(commands: readonly string[]): CorpusCase[] {
  return commands.map((command) => ({ command, expect: "gated" }));
}
/** Must never run silently, even for a project that allows everything. */
export function alwaysAsk(commands: readonly string[]): CorpusCase[] {
  return commands.map((command) => ({ command, expect: "gated", stress: true }));
}
export function notDenyAll(commands: readonly string[]): CorpusCase[] {
  return commands.map((command) => ({ command, expect: "not-deny" }));
}
