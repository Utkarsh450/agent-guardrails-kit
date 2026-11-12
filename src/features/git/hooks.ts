import { planFiles, type DesiredFile, type PlannedFile, type ReadExisting } from "../../shared/fs-plan.ts";
import { planTextBlocks } from "../../shared/text-block.ts";
import { STATE_GITIGNORE_LINES } from "../hooks/install.ts";
import { SECRETS_GITIGNORE_LINES } from "../secrets/index.ts";
import checksSource from "./git-checks/git-checks.mjs?raw";

export const GIT_CHECKS_PATH = ".agent-guardrails/git-checks.mjs";
export const HOOKS_DIR = ".githooks";
/** The one setting a person must make in each clone (agents are not allowed to run `git config`). */
export const HOOKS_PATH_COMMAND = `git config core.hooksPath ${HOOKS_DIR}`;

/**
 * Hook scripts must keep LF line endings. A Windows clone with core.autocrlf would otherwise turn them into CRLF,
 * and `sh` cannot run a script whose first line is `#!/bin/sh` followed by a carriage return.
 */
export const GITATTRIBUTES_LINES: readonly string[] = [`${HOOKS_DIR}/* text eol=lf`, ".agent-guardrails/*.mjs text eol=lf"];

export type HookName = "pre-commit" | "pre-push";

/**
 * A hook is a thin shell wrapper. If node or the checks file is missing, `exec` fails with a non-zero
 * exit code and git aborts the commit or push, so a broken setup blocks instead of silently passing.
 */
export function hookScript(name: HookName): string {
  return `#!/bin/sh
# agent-guardrails:generated ${name} hook. Update it with \`agent-guardrails update\`; do not edit by hand.
# Runs ${GIT_CHECKS_PATH}. If Node or that file is missing, git blocks the ${name === "pre-commit" ? "commit" : "push"}.
root="$(git rev-parse --show-toplevel)" || exit 1
exec node "$root/${GIT_CHECKS_PATH}" ${name} "$@"
`;
}

/** Hook scripts and the checks they run. */
export function desiredGitFiles(): DesiredFile[] {
  return [
    { path: `${HOOKS_DIR}/pre-commit`, content: hookScript("pre-commit"), generated: true, executable: true },
    { path: `${HOOKS_DIR}/pre-push`, content: hookScript("pre-push"), generated: true, executable: true },
    { path: GIT_CHECKS_PATH, content: checksSource, generated: true, executable: true },
  ];
}

/** Plans the hook files and the .gitignore blocks. Writes nothing. */
export async function planGitFiles(read: ReadExisting): Promise<PlannedFile[]> {
  const files = await planFiles(desiredGitFiles(), read);
  const gitignore = await planTextBlocks(
    ".gitignore",
    [
      { id: "state", lines: STATE_GITIGNORE_LINES },
      { id: "secrets", lines: SECRETS_GITIGNORE_LINES },
    ],
    read,
  );
  const gitattributes = await planTextBlocks(".gitattributes", [{ id: "line-endings", lines: GITATTRIBUTES_LINES }], read);
  return [...files, gitignore, gitattributes];
}

/** True when the text of .git/config sets core.hooksPath to the kit's hooks folder. */
export function isHooksPathConfigured(gitConfigText: string): boolean {
  let inCore = false;
  for (const raw of gitConfigText.split("\n")) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inCore = section[1]?.trim().toLowerCase() === "core";
    } else if (inCore) {
      const match = /^hookspath\s*=\s*(.+)$/i.exec(line);
      if (match) return match[1]?.trim().replace(/^"|"$/g, "").replace(/\/$/, "") === HOOKS_DIR;
    }
  }
  return false;
}

export { checksSource };
