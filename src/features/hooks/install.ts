import { CONFIG_FILE, DEFAULT_CONFIG } from "../../shared/config.ts";
import { planFiles, type DesiredFile, type PlannedFile, type ReadExisting } from "../../shared/fs-plan.ts";
import guardSource from "./guard/guard.mjs?raw";

/** Where the guard is installed, relative to the project root. */
export const GUARD_INSTALL_PATH = ".agent-guardrails/guard.mjs";

/** Local state the guard keeps. The guard script itself is committed; these two are per person and stay out of git. */
export const STATE_GITIGNORE_LINES: readonly string[] = [".agent-guardrails/audit.log", ".agent-guardrails/approval.json", ".agent-guardrails/checkpoints/"];

/** The settings file written when the project has none. Never overwritten afterwards. */
export function defaultConfigJson(): string {
  return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}

/**
 * The files every protected project gets, whatever agents it uses:
 *  - the guard script (generated, refreshed by `update`),
 *  - the project's guardrail settings (created once; after that it belongs to the user).
 */
export function desiredGuardFiles(): DesiredFile[] {
  return [
    { path: GUARD_INSTALL_PATH, content: guardSource, generated: true },
    { path: CONFIG_FILE, content: defaultConfigJson(), generated: false },
  ];
}

export function planGuardFiles(read: ReadExisting): Promise<PlannedFile[]> {
  return planFiles(desiredGuardFiles(), read);
}

export { guardSource };
