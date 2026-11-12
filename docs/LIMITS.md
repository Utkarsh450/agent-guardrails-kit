# What it cannot do

This kit lowers the chance that an AI agent does something harmful. It does not make that impossible. This page says where the gaps are, so you can cover them.

## It is one layer

Use it together with:

- the agents' own permission and sandbox settings (Codex: `approval_policy` and `sandbox_mode`; Claude Code and Qoder: permission rules)
- branch protection on GitHub (`agent-guardrails-kit explain branch-protection`)
- a database user that can only do what the work needs, and backups
- keeping production credentials off the machines where agents run

## Per agent

| Agent | What can be stopped | What cannot |
|---|---|---|
| Claude Code | Shell commands, file edits and reads, and MCP tools by name | Anything the hook cannot see (below) |
| Cursor | Shell commands and tool calls | The same, and tools Cursor does not route through hooks |
| Codex | Shell commands, patches and MCP tools. Needs `/hooks` trust, which this kit cannot check | It cannot ask you, so unknown commands are blocked outright |
| Qoder | Shell commands and tool calls in the CLI | The desktop IDE uses its own settings |
| Antigravity | **Nothing.** It has no hooks | All of it. Its permission rules match only command prefixes and switch off for compound commands, so they are a weak layer |

## What the guard cannot see

The guard reads the text of a command. So:

- **Script files: only patterns.** Just before `python script.py`, `node build.js`, `bash clean.sh` or `./build.sh` runs, the guard reads the file (inside the project, up to 256 KB, at most 3 files per command) and blocks it when it finds file deletion, a destructive database statement or a guardrail file in it. Shell scripts go through the same analysis as a typed command. It does **not** follow imports or other files, does not read `node_modules` or virtual environments, and misses code that is built at run time. A script with no finding still asks; "scanned" is not "safe". The file is read when the hook runs, so changing it afterwards is not prevented. Inline code (`python -c`, `node -e`) is checked for known-dangerous calls only.
- **Checkpoints cover the file tools only.** The old content of a file is saved before an agent's Write, Edit, MultiEdit, NotebookEdit or `apply_patch` call changes it. Changes made through a shell command (`sed -i`, `mv`, `cp`, `>` redirects) are not saved. Files over 1 MB, binary files, secret files and anything in `node_modules`, `.git`, `dist` or `build` are listed but not copied. The folder stops growing at 1,000 checkpoints or 200 MB, and the guard never deletes or rotates it. `restore` never deletes either: a file the agent created stays until you delete it.
- **Paths handed over through pipes.** `find . | xargs cat` passes file names the guard never sees, so it can read a secret file that way. Plain `grep -r`, `rg --hidden`, `diff -r` and `find -exec cat` are checked, within limits: the search looks at most 5,000 entries and 8 levels deep, and skips `node_modules`, `.git` and similar folders.
- **Package scripts.** `pnpm run clean` is checked by reading the script text in `package.json`. A script that runs `node clean.js` goes on to the script scan above.
- **MCP tools.** Only the tool's name can be judged: names that sound like an action (create, delete, send) ask you. A harmless-sounding name that does something harmful would pass.
- **Anything that is not a tool call.** IDE features, other programs on the machine, other agents, and things a person does by hand are outside it.
- **A determined agent.** A pattern list can always be argued around. That is why the guard asks about anything it does not recognise instead of trusting a list of known-bad things, and why it is not a sandbox.

## Settings that weaken it

- `policy: "blocklist"` lets commands the guard does not recognise run without asking. The default, `ask`, does not.
- `approvalGate: false` turns off the plan gate.
- **A team preset is trusted input.** `agent-guardrails-kit preset use` reads a file in the project or an installed package, and applies it to the settings. A preset can only keep or raise protection (no `blocklist`, no plan gate off, no broad programs in `allowCommands`, only read-only git commands), the change is shown as a diff first, and nothing is downloaded. But whoever controls that file or package controls those settings, so read the diff. A project keeps its own entries and the preset adds to them: a command the team later removes from the preset stays in projects that already received it until someone removes it by hand.
- `allowCommands` entries match any command that starts with those words, with any arguments. `"node"` alone would let an agent run any script. `agent-guardrails-kit doctor` warns about that. The hard blocks still apply to everything you allow.
- Bypassing a git hook with `git commit --no-verify` is possible for a person. The guard forbids it for agents.

## Secrets

The scanner looks for known key formats (AWS, GitHub, Slack, Stripe, Google, npm, OpenAI and Anthropic keys, private keys, JWTs, hard-coded passwords, passwords in database URLs). A secret in a format it does not know will not be found. The typosquat check compares new package names against about 250 popular ones and only warns.

## Local data

The audit log (`.agent-guardrails/audit.log`) and the dashboard stay on your machine. The dashboard is read-only and listens on `127.0.0.1`, but any program on that machine can read it. The log records the commands agents tried, and a command can contain something sensitive that was typed into it. It is gitignored and never sent anywhere.

## Platforms

- **macOS** is tested by hand, with Node and with the Bun runtime.
- **Linux** is covered by this repository's CI workflow (`.github/workflows/ci.yml`).
- **Hooks are read when a session starts.** A Claude Code session that was open before `init` or `update` may not use the new hooks, and Claude Code lets a tool call through when a hook does not run. Start a new session, then check with `agent-guardrails-kit test --prompt`. Reports exist of hooks not firing in some Claude Code setups on Windows. I did not reproduce them: a fresh session in the VS Code extension did block.
- **Windows works through Git Bash, with gaps.** The hook commands and git hooks use POSIX shell syntax, so Git for Windows must be installed. The unit tests, the hook commands run through Git Bash (including a project path with spaces, and failing closed when the guard or Node is missing) and real git hooks pass on Windows 11. Not covered: Windows with no Git Bash, `cmd.exe` as the hook shell, and `agent-guardrails-kit alerts --notify` (desktop notifications are macOS and Linux only).
- **The PowerShell tool is checked, but only partly PowerShell-aware.** The guard reads PowerShell commands with its shell rules, after turning `\` into `/`. `git push`, `gh`, `rm` and `Remove-Item` are blocked, and read-only commands (`Get-Content`, `Get-ChildItem`, `Select-String`, `Set-Location` and their aliases) run inside the project with the same path and secret checks as `cat` and `ls`. Every other cmdlet is an unknown program and asks, and PowerShell syntax such as script blocks is not analysed. Claude Code's `permissions.deny` rules written by `init` name `Bash(...)` only; the hook is the protection for PowerShell.
- **Windows paths.** The guard compares paths without regard to letter case, expands short names such as `UTKARS~1`, and reads Git Bash paths (`/c/Users/...`) as drive paths. Hook scripts are kept LF by a `.gitattributes` block `init` writes, because a CRLF hook cannot run under `sh`.
- Other runtimes than Node and Bun are not tested.

## Other things to know

- The guard needs `node` on the PATH of the agent. If it is missing, every action is blocked.
- A Codex hook must be trusted again after the kit changes it (`/hooks`).
- Agents' hook formats change. `agent-guardrails-kit doctor` checks the files, not whether the agent still honours them. Run `agent-guardrails-kit test --prompt` after upgrading an agent.

## Found a way around it?

That is the most useful thing you can tell me. See [SECURITY.md](../SECURITY.md).
