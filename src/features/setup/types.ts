import type { AgentId } from "../../shared/agents.ts";
import type { PlannedFile } from "../../shared/fs-plan.ts";
import type { Preset, Stack } from "../../shared/config.ts";
import type { Enforcement } from "../agents/index.ts";
import type { PackageManager } from "../package-manager/index.ts";

/** Everything a person chooses during `init`. */
export interface SetupOptions {
  agents: AgentId[];
  preset: Preset;
  stack: Stack;
  /** Detected from the project; used for stack commands and hints. */
  packageManager: PackageManager | null;
  /** Set up the .github folder (templates, CODEOWNERS, CI workflow). */
  github: boolean;
  /** When set, the CI workflow also runs `doctor --ci` from this published package. */
  doctorPackage?: { packageName: string; version: string };
}

export type PlanGroup = "rules" | "config" | "guard" | "agents" | "git" | "github";

export interface PlanEntry {
  group: PlanGroup;
  file: PlannedFile;
}

export interface Note {
  title: string;
  lines: string[];
}

export interface SetupPlan {
  options: SetupOptions;
  entries: PlanEntry[];
  /** Steps only the person can do, grouped by topic. */
  notes: Note[];
  warnings: string[];
  /** Generated files whose source rule is gone. Reported, never deleted. */
  stale: string[];
  enforcement: Array<{ agent: AgentId; enforcement: Enforcement }>;
  git: {
    /** The project has a .git folder. */
    isRepo: boolean;
    /** Whether core.hooksPath is already set to .githooks (null when unknown). */
    hooksPathSet: boolean | null;
    command: string;
  };
}
