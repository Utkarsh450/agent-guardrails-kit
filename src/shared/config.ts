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

export const PRESETS = ["learner", "balanced", "team", "light"] as const;
export type Preset = (typeof PRESETS)[number];

export const STACKS = ["generic", "node-ts", "python", "go", "db-heavy"] as const;
export type Stack = (typeof STACKS)[number];

/** The keys the guard itself reads. The rest of the file is for the CLI and is ignored by the guard. */
export const GUARD_CONFIG_KEYS = ["version", "policy", "allowCommands", "gitAllow", "approvalGate", "planFile", "auditAllowed", "mode", "watchUntil", "checkpoints"] as const;

/** enforce = the guard asks and blocks as normal. watch = "ask" decisions are logged and let through for a limited time. */
export const MODES = ["enforce", "watch"] as const;
export type Mode = (typeof MODES)[number];
/** Watch mode can never last longer than this many days from now, whatever the settings file says. */
export const WATCH_MAX_DAYS = 30;
export const WATCH_DEFAULT_DAYS = 7;

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
  /** Block file writes until the human has approved the plan (see `agent-guardrails-kit approve`). */
  approvalGate: z.boolean().default(true),
  /** Plan file the agent writes and the human approves. */
  planFile: z.string().trim().min(1).default("PLAN.md"),
  /** Also record allowed actions in the audit log (denied and asked actions are always recorded). */
  auditAllowed: z.boolean().default(false),
  /**
   * "watch" lets actions the guard would ASK about run and records them (flagged "watched") until `watchUntil`.
   * Hard blocks still block. Without a valid `watchUntil` in the future the guard enforces, so watch mode always ends.
   */
  mode: z.enum(MODES).default("enforce"),
  /** When watch mode ends: an ISO date-time, or null. Set by `agent-guardrails-kit mode watch`. */
  watchUntil: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: "must be a date and time such as 2026-11-14T09:00:00.000Z" })
    .nullable()
    .default(null),
  /**
   * Before an agent's file write is allowed, save the file's old content under .agent-guardrails/checkpoints/ so
   * `agent-guardrails-kit restore` can put it back. Size limits apply and nothing is ever deleted.
   */
  checkpoints: z.boolean().default(true),

  // The settings below are read by the CLI (init, update, doctor, sync). The guard ignores them.
  /** Agents this project is set up for. */
  agents: z.array(z.enum(AGENT_IDS)).default([]),
  preset: z.enum(PRESETS).default("balanced"),
  stack: z.enum(STACKS).default("generic"),
  /** Also write always-on rules as per-agent files (off by default: those agents read AGENTS.md). */
  alwaysRuleFiles: z.boolean().default(false),
  /** Whether init sets up the .github folder. */
  github: z.boolean().default(true),
  /**
   * The team preset this project follows: "./file.json" in the project, or the name of an installed package.
   * Set by `agent-guardrails-kit preset use`; `update` applies it again.
   */
  extends: z.string().optional(),
  /** Fingerprint of the preset settings when they were applied, so `doctor` can see that the source changed. */
  extendsHash: z.string().optional(),
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
