import { z } from "zod";
import { AGENT_IDS } from "./agents.ts";

/**
 * Project guardrail settings, stored in `agent-guardrails.config.json` at the project root.
 * The guard hook (guard.mjs) validates the same shape on its own because it has no dependencies.
 * Keep DEFAULT_CONFIG in sync with the copy inside guard.mjs (a test checks this).
 */

export const CONFIG_FILE = "agent-guardrails.config.json";

export const POLICIES = ["ask", "blocklist", "allowlist"] as const;
export type Policy = (typeof POLICIES)[number];

export const PRESETS = ["learner", "balanced", "team"] as const;
export type Preset = (typeof PRESETS)[number];

export const STACKS = ["generic", "node-ts", "python", "go", "db-heavy"] as const;
export type Stack = (typeof STACKS)[number];

/** The keys the guard itself reads. The rest of the file is for the CLI and is ignored by the guard. */
export const GUARD_CONFIG_KEYS = ["version", "policy", "allowCommands", "gitAllow", "approvalGate", "planFile", "auditAllowed"] as const;

export const configSchema = z.object({
  version: z.literal(1).default(1),
  /**
   * What to do with a shell command that is neither blocked nor known read-only:
   *  - ask: prompt the user (Codex cannot prompt, so it is denied with an "ask the user" message)
   *  - blocklist: allow it
   *  - allowlist: deny it unless it matches allowCommands
   */
  policy: z.enum(POLICIES).default("ask"),
  /** Commands that run without asking. Token-prefix match per command, e.g. "pnpm test". Never overrides a hard block. */
  allowCommands: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .refine((pattern) => pattern.split(/\s+/)[0] !== "*", {
          message: 'must start with a command name, not "*"',
        }),
    )
    .default([]),
  /** Read-only git subcommands agents may run. */
  gitAllow: z.array(z.string().trim().min(1)).default(["status", "diff", "log", "show"]),
  /** Block file writes until the human has approved the plan (see `agent-guardrails approve`). */
  approvalGate: z.boolean().default(true),
  /** Plan file the agent writes and the human approves. */
  planFile: z.string().trim().min(1).default("PLAN.md"),
  /** Also record allowed actions in the audit log (denied and asked actions are always recorded). */
  auditAllowed: z.boolean().default(false),

  // The settings below are read by the CLI (init, update, doctor, sync). The guard ignores them.
  /** Agents this project is set up for. */
  agents: z.array(z.enum(AGENT_IDS)).default([]),
  preset: z.enum(PRESETS).default("balanced"),
  stack: z.enum(STACKS).default("generic"),
  /** Also write always-on rules as per-agent files (off by default: those agents read AGENTS.md). */
  alwaysRuleFiles: z.boolean().default(false),
  /** Whether init sets up the .github folder. */
  github: z.boolean().default(true),
});

export type GuardrailsConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: GuardrailsConfig = configSchema.parse({});

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function parseConfig(raw: string): GuardrailsConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON (${detail})`);
  }
  const result = configSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`${CONFIG_FILE} is invalid (${issues})`);
  }
  return result.data;
}
