import type { ReadExisting } from "../../shared/fs-plan.ts";
import { PRESETS, STACKS, type GuardrailsConfig, type Preset, type Stack } from "../../shared/config.ts";
import { scriptCommands, type PackageManager } from "../package-manager/index.ts";

export { PRESETS, STACKS, type Preset, type Stack };

export const PRESET_SUMMARY: Record<Preset, string> = {
  learner: "Strictest. Asks about unknown commands, records every action in the audit log, and repeats the always-on rules in each agent's own folder.",
  balanced: "The default. Asks about unknown commands, blocks the dangerous ones, and needs an approved plan before files change.",
  team: "Same protection, fewer interruptions: common test, build and lint commands for your stack run without asking, and a few more read-only git commands are allowed.",
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

/** The guard settings a preset stands for. Every preset keeps the plan gate on and asks about unknown commands. */
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
  if (preset === "team") {
    base.gitAllow = [...BASE_GIT_ALLOW, ...TEAM_GIT_ALLOW];
    base.allowCommands = stackAllowCommands(stack, manager);
  }
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
