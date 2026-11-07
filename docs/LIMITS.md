# What it cannot do

This kit lowers the chance that an AI agent does something harmful. It does not make that impossible. This page says where the gaps are, so you can cover them.

## It is one layer

Use it together with:

- the agents' own permission and sandbox settings (Codex: `approval_policy` and `sandbox_mode`; Claude Code and Qoder: permission rules)
- branch protection on GitHub (`agent-guardrails explain branch-protection`)
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

- **Script files.** `python script.py` or `./build.sh`: it asks about them, but it cannot read what they do. It reads inline code (`python -c`, `node -e`) for known-dangerous calls only.
- **Paths handed over through pipes.** `find . | xargs cat` passes file names the guard never sees, so it can read a secret file that way. Plain `grep -r`, `rg --hidden`, `diff -r` and `find -exec cat` are checked, within limits: the search looks at most 5,000 entries and 8 levels deep, and skips `node_modules`, `.git` and similar folders.
- **Package scripts.** `pnpm run clean` is checked by reading the script text in `package.json`. A script that runs `node clean.js` is not read further.
- **MCP tools.** Only the tool's name can be judged: names that sound like an action (create, delete, send) ask you. A harmless-sounding name that does something harmful would pass.
- **Anything that is not a tool call.** IDE features, other programs on the machine, other agents, and things a person does by hand are outside it.
- **A determined agent.** A pattern list can always be argued around. That is why the guard asks about anything it does not recognise instead of trusting a list of known-bad things, and why it is not a sandbox.

## Settings that weaken it

- `policy: "blocklist"` lets commands the guard does not recognise run without asking. The default, `ask`, does not.
- `approvalGate: false` turns off the plan gate.
- `allowCommands` entries match any command that starts with those words, with any arguments. `"node"` alone would let an agent run any script. `agent-guardrails doctor` warns about that. The hard blocks still apply to everything you allow.
- Bypassing a git hook with `git commit --no-verify` is possible for a person. The guard forbids it for agents.

## Secrets

The scanner looks for known key formats (AWS, GitHub, Slack, Stripe, Google, npm, OpenAI and Anthropic keys, private keys, JWTs, hard-coded passwords, passwords in database URLs). A secret in a format it does not know will not be found. The typosquat check compares new package names against about 250 popular ones and only warns.

## Local data

The audit log (`.agent-guardrails/audit.log`) and the dashboard stay on your machine. The dashboard is read-only and listens on `127.0.0.1`, but any program on that machine can read it. The log records the commands agents tried, and a command can contain something sensitive that was typed into it. It is gitignored and never sent anywhere.

## Platforms

- **macOS** is tested by hand, with Node and with the Bun runtime.
- **Linux** is covered by this repository's CI workflow (`.github/workflows/ci.yml`).
- **Windows is not supported yet.** The hook commands and git hooks use POSIX shell syntax. They may work under Git Bash, but nobody has checked. The CI workflow runs Windows as an experiment that is allowed to fail.
- Other runtimes than Node and Bun are not tested.

## Other things to know

- The guard needs `node` on the PATH of the agent. If it is missing, every action is blocked.
- A Codex hook must be trusted again after the kit changes it (`/hooks`).
- Agents' hook formats change. `agent-guardrails doctor` checks the files, not whether the agent still honours them. Run `agent-guardrails test --prompt` after upgrading an agent.

## Found a way around it?

That is the most useful thing you can tell me. See [SECURITY.md](../SECURITY.md).
