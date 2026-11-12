/** Where the guard is installed, relative to the project root. */
export const GUARD_PATH = ".agent-guardrails/guard.mjs";

/** Text that identifies a hook command as ours, so reruns update it instead of adding a second copy. */
export const GUARD_MARKER = GUARD_PATH;

/** Seconds. The guard answers in well under a second; this only stops a hung process. */
export const HOOK_TIMEOUT_SECONDS = 30;

/**
 * Hook commands. Fail-closed on purpose: `|| exit 2` turns "node is missing", "the guard file is missing" or
 * "the guard crashed" (all exit codes other than 0 and 2, which agents treat as a harmless hook error) into a
 * block (exit 2). Without it a broken guard would silently allow every action.
 */
export const commands = {
  claude: `node "$CLAUDE_PROJECT_DIR/${GUARD_PATH}" --agent claude || exit 2`,
  qoder: `node "$QODER_PROJECT_DIR/${GUARD_PATH}" --agent qoder || exit 2`,
  /** Cursor runs project hooks from the project root and has its own `failClosed` option. */
  cursor: `node ${GUARD_PATH} --agent cursor`,
  /**
   * Codex runs hooks from the session's working directory and has no project-root variable, so the command
   * walks up from there until it finds the guard. If it finds none it points at "/" and fails, which blocks.
   */
  codex: `d="$PWD"; while [ "$d" != "/" ] && [ ! -f "$d/${GUARD_PATH}" ]; do d="$(dirname "$d")"; done; node "$d/${GUARD_PATH}" --agent codex || exit 2`,
} as const;

/** Tools the guard inspects. Everything else (web, planning, subagents) does not need a process per call. */
export const matchers = {
  claude: "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|Read|Glob|Grep",
  claudeMcp: "mcp__.*",
  qoder: "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Glob|Grep",
  qoderMcp: "mcp__.*",
  cursorTools: "Write|Delete|Read|Grep|MCP:.*",
  codex: "Bash|apply_patch|mcp__.*",
} as const;

/**
 * A second layer inside the agent's own permission system. It still works if the hook ever fails,
 * but it only matches simple command prefixes, so the hook stays the main protection.
 */
const gitWriteSubcommands = [
  "push", "commit", "add", "reset", "clean", "rebase", "merge", "pull", "fetch", "checkout", "switch", "restore",
  "stash", "cherry-pick", "revert", "tag",
] as const;

export const claudeDenyRules: readonly string[] = [
  "Bash(rm)", "Bash(rm *)", "Bash(rmdir *)", "Bash(sudo *)", "Bash(gh *)", "Bash(kill *)", "Bash(pkill *)", "Bash(killall *)",
  ...gitWriteSubcommands.map((sub) => `Bash(git ${sub} *)`),
  "Bash(npm publish *)", "Bash(pnpm publish *)", "Bash(yarn publish *)", "Bash(bun publish *)", "Bash(docker push *)",
  "Read(./.env)", "Read(./.env.*)", "Read(./**/*.pem)", "Read(./**/id_rsa*)",
];

/** Qoder uses the same idea with its own rule syntax (`Bash(cmd:*)`, gitignore-style paths). */
export const qoderDenyRules: readonly string[] = [
  "Bash(rm:*)", "Bash(rmdir:*)", "Bash(sudo:*)", "Bash(gh:*)", "Bash(kill:*)", "Bash(pkill:*)", "Bash(killall:*)",
  ...gitWriteSubcommands.map((sub) => `Bash(git ${sub}:*)`),
  "Bash(npm publish:*)", "Bash(pnpm publish:*)", "Bash(yarn publish:*)", "Bash(bun publish:*)", "Bash(docker push:*)",
  "Read(.env)", "Read(.env.*)", "Read(*.pem)", "Read(id_rsa*)",
];

/** Antigravity's CLI settings live in the user's home folder, so the kit only prints this snippet. */
export const antigravityPermissions = {
  permissions: {
    deny: [
      "command(rm)", "command(rmdir)", "command(unlink)", "command(shred)", "command(sudo)", "command(su)",
      "command(gh)", "command(kill)", "command(pkill)", "command(killall)",
      ...gitWriteSubcommands.map((sub) => `command(git ${sub})`),
      "command(npm publish)", "command(pnpm publish)", "command(yarn publish)", "command(bun publish)",
      "command(docker push)",
      "read_file(.env)", "read_file(.env.local)", "read_file(.env.production)",
      "write_file(.git/)", "write_file(.githooks/)", "write_file(.agent-guardrails/)", "write_file(agent-guardrails.config.json)",
    ],
    allow: [
      "command(ls)", "command(cat)", "command(head)", "command(tail)", "command(grep)", "command(rg)", "command(pwd)",
      "command(git status)", "command(git diff)", "command(git log)", "command(git show)",
    ],
    ask: [] as string[],
  },
};
