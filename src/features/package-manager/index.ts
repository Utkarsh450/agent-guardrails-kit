import type { ReadExisting } from "../../shared/fs-plan.ts";

export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface Detected {
  /** The manager the project uses, or null when nothing says. */
  manager: PackageManager | null;
  /** What gave it away (a field or a lockfile), for showing the user. */
  evidence: string | null;
  /** More than one manager's lockfile is present; the project should pick one. */
  ambiguous: PackageManager[];
}

const LOCKFILES: Array<{ file: string; manager: PackageManager }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
];

function isManager(name: string): name is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(name);
}

/** Works out which package manager a project uses from package.json's packageManager field, then lockfiles. */
export async function detectPackageManager(read: ReadExisting): Promise<Detected> {
  const present: Array<{ file: string; manager: PackageManager }> = [];
  for (const entry of LOCKFILES) {
    if ((await read(entry.file)) !== null) present.push(entry);
  }
  const lockManagers = [...new Set(present.map((entry) => entry.manager))];

  const pkg = await read("package.json");
  if (pkg !== null && pkg.kind === "file") {
    try {
      const field = (JSON.parse(pkg.content) as { packageManager?: unknown }).packageManager;
      if (typeof field === "string") {
        const name = field.split("@")[0] ?? "";
        if (isManager(name)) return { manager: name, evidence: `package.json packageManager "${field}"`, ambiguous: [] };
      }
    } catch {
      // fall back to lockfiles
    }
  }

  if (lockManagers.length === 0) return { manager: null, evidence: null, ambiguous: [] };
  const first = present[0]!;
  return {
    manager: first.manager,
    evidence: first.file,
    ambiguous: lockManagers.length > 1 ? lockManagers : [],
  };
}

export interface ScriptCommands {
  test: string;
  build: string;
  lint: string;
  typecheck: string;
}

/** The command that runs a package script with each manager (npm needs `run` for everything but test). */
export function scriptCommands(manager: PackageManager): ScriptCommands {
  switch (manager) {
    case "npm":
      return { test: "npm test", build: "npm run build", lint: "npm run lint", typecheck: "npm run typecheck" };
    case "pnpm":
      return { test: "pnpm test", build: "pnpm build", lint: "pnpm lint", typecheck: "pnpm typecheck" };
    case "yarn":
      return { test: "yarn test", build: "yarn build", lint: "yarn lint", typecheck: "yarn typecheck" };
    case "bun":
      return { test: "bun test", build: "bun run build", lint: "bun run lint", typecheck: "bun run typecheck" };
  }
}

/** How to run a package without installing it, for hints shown to the user. */
export function runnerCommand(manager: PackageManager): string {
  switch (manager) {
    case "npm":
      return "npx";
    case "pnpm":
      return "pnpm dlx";
    case "yarn":
      return "yarn dlx";
    case "bun":
      return "bunx";
  }
}
