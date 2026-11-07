# agent-guardrails-kit

One command that puts safety rails around AI coding agents: **Claude Code, Cursor, Codex, Antigravity and Qoder**.

It sets up shared rules every agent reads, hooks that block dangerous actions, git hooks that catch secrets and force pushes, and GitHub files. It asks before it writes anything, and it never deletes anything.

> **Status: pre-release.** This lowers risk. It does not remove it. Read [what it cannot do](docs/LIMITS.md) before you rely on it.

## Quick start

You need Node 22.12 or newer and git.

### Install from GitHub (works today)

The package is not on npm yet, so build it from this repository first. You do this once.

| Step | Command | What it does |
|---|---|---|
| 1 | `git clone https://github.com/Utkarsh450/agent-guradrails-kit.git` | Copies the code to your machine |
| 2 | `cd agent-guradrails-kit` | Goes into the copied folder |
| 3 | `pnpm install` | Installs the dependencies |
| 4 | `pnpm build` | Builds the command into `dist/cli.mjs` |

Then, inside **your own project folder**, run it with the full path to the file you just built:

```bash
node /path/to/agent-guradrails-kit/dist/cli.mjs init
```

Replace `/path/to/agent-guradrails-kit` with the folder you cloned. To type `agent-guardrails` instead of the long command, add an alias in your shell:

```bash
alias agent-guardrails="node /path/to/agent-guradrails-kit/dist/cli.mjs"
```

### After it is published to npm

Not available yet. When the package is published, this will work in your project folder, with no clone or build:

```bash
npx agent-guardrails-kit init
```

```bash
pnpm dlx agent-guardrails-kit init
```

```bash
bunx agent-guardrails-kit init
```

### What `init` does

It asks which agents you use and how strict to be, shows you the full list of files it would create, and waits for your yes. Then:

```bash
agent-guardrails doctor          # what is protected, what is advisory only, what is out of date
agent-guardrails test --hooks    # proves the guard blocks what it should
agent-guardrails test --prompt   # a prompt to test your agent for real, in a throwaway copy
```

(`agent-guardrails-kit` works as the command name too.)

## Try it safely first

Test it in a throwaway folder before you trust it in a real project. Nothing here touches your real work.

| Step | Command | What it does |
|---|---|---|
| 1 | `mkdir guardrails-sandbox`, then `cd guardrails-sandbox`, then `git init` | Makes a new, empty test folder |
| 2 | `agent-guardrails init --dry-run` | Only shows the files it would create. Writes nothing |
| 3 | `agent-guardrails init` | Sets up the guard in the sandbox, after your yes |
| 4 | `agent-guardrails doctor`, then `agent-guardrails test --hooks` | Shows what is protected, and proves the guard blocks dangerous commands without any agent |
| 5 | `agent-guardrails alerts --notify` in a second terminal tab | Shows blocked and asked actions as they happen |
| 6 | `agent-guardrails test --prompt` | Prints a prompt. Open your agent in the sandbox folder and paste it. The agent then tries to delete a file, push, write outside the folder and more |

### What to look for

| You should see | Why |
|---|---|
| A `BLOCKED` line in the alerts tab for each dangerous attempt | The guard stopped it before it ran |
| The agent cannot create or change files until you run `agent-guardrails approve` | The plan has to be approved first |
| `agent-guardrails checkpoints` lists copies of files the agent changed | Old content is saved before an agent's file tool edits a file. `agent-guardrails restore <id>` puts it back |
| After `agent-guardrails mode watch`, unknown commands run and are logged as `WATCHED` | Watch mode skips the questions for a while. Blocked actions stay blocked |

If something dangerous ran that should have been blocked, report it as described in [SECURITY.md](SECURITY.md). That is the most useful result a test can give.

## What you get

| Layer | What it does |
|---|---|
| **Shared rules** | One set of rule files in `agent-rules/` becomes `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and each agent's own rule folder. Plan first, ask first, no deleting, no git changes, stay in the folder, no secrets. |
| **The guard** | A hook that runs before every agent action. It blocks file and database deletes, git writes, `gh`, publishing, anything outside the project, secret files, and more. It asks you about commands it does not recognise. If it breaks, it blocks (fails closed). |
| **Plan approval** | Agents cannot create or change files until you read their plan (`PLAN.md`) and run `agent-guardrails approve`. Editing the plan afterwards cancels the approval. |
| **Checkpoints** | Before an agent's file tool changes a file, the old content is saved under `.agent-guardrails/checkpoints/` (1 MB per file, 200 MB in all, never deleted). `agent-guardrails restore` puts it back. Changes made through shell commands such as `sed -i` are not covered. |
| **Script scanning** | A script file is read just before it runs. One that deletes files, drops database data or touches the guardrail files is blocked, with the file and line named. It checks patterns only: imports are not followed. |
| **Git hooks** | Whichever tool made the change: secrets in commits, risky new dependencies and dangerous install scripts, force pushes and deleting the main branch, release branches or tags are stopped. |
| **GitHub files** | Pull request template, issue templates, CODEOWNERS and a CI check, with actions pinned to commits. |
| **Dashboard** | `agent-guardrails ui` opens a read-only page with the doctor report, the setup plan, what the guard blocked, and the test prompts. |

## Which agents are really protected

| Agent | Protection | How |
|---|---|---|
| Claude Code | **Enforced** | A hook checks every tool call, plus permission deny rules |
| Cursor | **Enforced** | Hooks on shell commands and tool calls, fail closed |
| Codex | **Enforced** | A hook (you trust it once with `/hooks`). Codex cannot ask you, so the guard blocks what it would ask about and tells the agent to ask you in chat |
| Qoder | **Enforced** | Hooks in `.qoder/settings.json` |
| Antigravity | **Advisory only** | It has no hooks. Nothing here can block it; the rules are only instructions. You add permission rules yourself (`agent-guardrails explain antigravity`) |

`agent-guardrails doctor` tells you this for your own project.

## Day to day

| Command | What it does |
|---|---|
| `agent-guardrails init` | Set everything up. Shows the plan, asks, then writes. `--dry-run` only shows. |
| `agent-guardrails update` | Refresh the generated files from the current version. Your own files are never overwritten. |
| `agent-guardrails doctor` | Check the setup. Exits 1 on a problem (for CI: `--ci`). |
| `agent-guardrails approve` | You read the agent's `PLAN.md` and approve it, so it may start changing files. |
| `agent-guardrails allow add "pnpm test"` | Stop being asked about a command you trust. Dangerous commands can never be allowed this way. |
| `agent-guardrails report` | What the agents tried: blocked and asked actions from the local log. |
| `agent-guardrails checkpoints [id]` | List the copies of files the guard saved before an agent changed them, or show what one holds. |
| `agent-guardrails restore <id>` | Put the saved files back. Shows a diff and asks first, and never deletes. Add `--file <path>` for one file. |
| `agent-guardrails alerts` | Follow blocked and asked actions live in a spare terminal tab. Add `--notify` for desktop notifications (macOS and Linux). Press Ctrl+C to stop. |
| `agent-guardrails explain <reason>` | Why something was blocked, in plain words, and what to do instead. |
| `agent-guardrails sync` | Regenerate `AGENTS.md` and the per-agent files after you edit `agent-rules/`. |
| `agent-guardrails preset <name>` | Switch between `learner`, `balanced` and `team`. |
| `agent-guardrails preset export [file]` | Write this project's settings as a team preset file you can share. |
| `agent-guardrails preset use <file or package>` | Follow a team preset. Shows the change and asks first. `update` applies it again later. |
| `agent-guardrails mode [watch\|enforce]` | Try the kit without interruptions: `watch` lets actions it would ask about run, and logs them, for up to 30 days (default 7). Blocked actions stay blocked. |
| `agent-guardrails test` | `--hooks` proves the guard. `--prompt` and `--gap-review` print prompts to test an agent. |
| `agent-guardrails ui` | The read-only dashboard. |

When the guard blocks something, the message names a reason. `agent-guardrails explain <reason>` says why and what to do.

## Strictness

All three keep the dangerous-command blocks, ask about unknown commands, and require an approved plan.

| Preset | Difference |
|---|---|
| `learner` | Logs every action and repeats the rules in each agent's own folder |
| `balanced` (default) | The standard setup |
| `team` | Your stack's test, build and lint commands run without asking, plus a few more read-only git commands |

## Share one setup across projects

A team writes its settings once and every project follows them.

1. In a project set up the way the team wants, save the settings as a preset file:

   ```bash
   agent-guardrails preset export team-preset.json --name acme
   ```

2. Share the file: commit it, copy it, or publish an npm package that holds it as `guardrails-preset.json`.
3. In any other project, follow it. The change is shown as a diff first:

   ```bash
   agent-guardrails preset use ./team-preset.json
   ```

   For a package that is already installed, use its name instead: `agent-guardrails preset use @acme/guardrails-preset`.
4. `agent-guardrails update` applies the preset again whenever it changes, and `agent-guardrails doctor` tells you if a project fell behind.

A preset can only keep or raise protection. It cannot allow unknown commands to run, switch off the plan gate or logging, set watch mode, or allow broad commands such as `bash` or `node`. A project keeps its own settings and the preset adds to them. Presets are never downloaded: they come from a file in the project or a package you installed yourself.

## How it keeps itself safe

- **Nothing is written without your say-so**, and nothing is ever deleted. Files it did not create are left alone.
- **It fails closed.** If the guard cannot run, the action is blocked, not allowed.
- **Agents cannot use its own commands.** `approve`, `allow`, `init`, `update`, `sync`, `preset`, `mode`, `alerts`, `restore` and `ui` are blocked for agents, so an agent cannot approve its own plan or widen its own permissions.
- **No telemetry.** Everything stays on your machine, including the audit log.
- **The dashboard is read-only** and listens on `127.0.0.1` only.

## Requirements

Node 22.12 or newer and git. Works with npm, pnpm and bun (the CLI also runs under the Bun runtime). Tested by hand on macOS. Linux is covered by this repository's CI workflow. Windows is not supported yet (see [limits](docs/LIMITS.md)).

## Troubleshooting

- **Everything is blocked.** The guard fails closed. Run `agent-guardrails doctor`: usually Node is missing from the agent's PATH, or `agent-guardrails.config.json` is invalid.
- **A harmless command keeps asking.** `agent-guardrails allow add "<command>"`.
- **The git hooks do nothing.** Each clone needs `git config core.hooksPath .githooks` (`init` offers to run it).
- **Codex ignores the hook.** Open Codex in the project and run `/hooks` to trust it.
- **I edited a rule and the agent did not notice.** Run `agent-guardrails sync`.

## More

- [What it cannot do](docs/LIMITS.md)
- [How it is built](docs/ARCHITECTURE.md)
- [Publishing it yourself](docs/PUBLISHING.md)
- [Reporting a security problem](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT. See [LICENSE](LICENSE).
