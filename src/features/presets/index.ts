import type { ReadExisting } from "../../shared/fs-plan.ts";
import { PRESETS, STACKS, type GuardrailsConfig, type Preset, type Stack } from "../../shared/config.ts";
import { scriptCommands, type PackageManager } from "../package-manager/index.ts";

export { PRESETS, STACKS, type Preset, type Stack };

export const PRESET_SUMMARY: Record<Preset, string> = {
  learner: "Strictest. Asks about unknown commands, records every action in the audit log, and repeats the always-on rules in each agent's own folder.",
  balanced: "The default. Your stack's test, build and lint commands run without asking, unknown commands ask, dangerous ones are blocked, and files change only after you approve a plan.",
  team: "Like balanced, plus a few more read-only git commands (ls-files, blame, rev-parse and similar).",
  light: "Fewest interruptions. Like team, but agents can edit files without an approved plan. Dangerous actions are still blocked, and old file content is saved so you can restore it.",
};

export const STACK_SUMMARY: Record<Stack, string> = {
  generic: "No stack-specific settings.",
  "node-ts": "Node and TypeScript: test, build, lint and typecheck scripts (team preset).",
  python: "Python: pytest, ruff and mypy (team preset).",
  go: "Go: go test, go build and go vet (team preset).",
  "db-heavy": "Database-heavy work: everything the guard allows is also logged.",
};

/** Read-only git subcommands the team preset adds. None of them changes the repository. */
export const TEAM_GIT_ALLOW = ["ls-files", "ls-tree", "rev-parse", "rev-list", "merge-base", "blame", "shortlog", "describe"] as const;

const BASE_GIT_ALLOW = ["status", "diff", "log", "show"] as const;

/** Every read-only git subcommand a preset may allow. */
export const SAFE_GIT_ALLOW: readonly string[] = [...BASE_GIT_ALLOW, ...TEAM_GIT_ALLOW];

/** Programs that run whatever script they are given; allowing one with no arguments allows almost anything. */
export const BROAD_PROGRAMS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "fish", "node", "python", "python3", "ruby", "perl", "php", "deno", "bun", "tsx", "ts-node", "env", "xargs", "find", "make"]);

/** Commands the team preset lets run without asking. Hard blocks still apply to all of them. */
export function stackAllowCommands(stack: Stack, manager: PackageManager | null): string[] {
  switch (stack) {
    case "node-ts": {
      const commands = scriptCommands(manager ?? "npm");
      return [commands.test, commands.build, commands.lint, commands.typecheck, "tsc --noEmit", "vitest run"];
    }
    case "python":
      return ["pytest", "python -m pytest", "ruff check", "mypy"];
    case "go":
      return ["go test", "go build", "go vet"];
    case "generic":
    case "db-heavy":
      return [];
  }
}

export type PresetSettings = Pick<
  GuardrailsConfig,
  "policy" | "allowCommands" | "gitAllow" | "approvalGate" | "auditAllowed" | "alwaysRuleFiles"
>;

/** The guard settings a preset stands for. Every preset asks about unknown commands; only `light` turns the plan gate off. */
export function presetSettings(preset: Preset, stack: Stack, manager: PackageManager | null): PresetSettings {
  const base: PresetSettings = {
    policy: "ask",
    allowCommands: [],
    gitAllow: [...BASE_GIT_ALLOW],
    approvalGate: true,
    auditAllowed: false,
    alwaysRuleFiles: false,
  };

  if (preset === "learner") base.auditAllowed = true;
  if (preset === "learner") base.alwaysRuleFiles = true;
  // Your stack's own test, build and lint commands are safe to run, so only the strictest preset still asks about them.
  if (preset !== "learner") base.allowCommands = stackAllowCommands(stack, manager);
  if (preset === "team" || preset === "light") base.gitAllow = [...BASE_GIT_ALLOW, ...TEAM_GIT_ALLOW];
  // Light skips the plan gate. Checkpoints (on by default) still save the old content of every file an agent changes.
  if (preset === "light") base.approvalGate = false;
  if (stack === "db-heavy") base.auditAllowed = true;
  return base;
}

/**
 * Looks at a project's files and suggests a stack. Reads only.
 * A language wins over "db-heavy": a Node project that uses Prisma keeps its Node commands, and the person
 * can still choose db-heavy on purpose.
 */
export async function detectStack(read: ReadExisting): Promise<{ stack: Stack; evidence: string | null }> {
  const has = async (...paths: string[]) => {
    for (const rel of paths) if ((await read(rel)) !== null) return rel;
    return null;
  };

  const node = await has("tsconfig.json", "package.json");
  if (node) return { stack: "node-ts", evidence: node };
  const python = await has("pyproject.toml", "requirements.txt", "setup.py", "Pipfile");
  if (python) return { stack: "python", evidence: python };
  const go = await has("go.mod");
  if (go) return { stack: "go", evidence: go };
  const db = await has("prisma", "drizzle", "migrations", "db/migrate", "alembic.ini");
  if (db) return { stack: "db-heavy", evidence: db };
  return { stack: "generic", evidence: null };
}
