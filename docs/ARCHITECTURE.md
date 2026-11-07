# How it is built

A map for people who want to change or extend the kit. Everything is organised by feature: the code, templates and tests for one feature live together.

## Layout

```
src/
  cli.ts, program.ts          the commander program; each command is a thin layer
  shared/                     small helpers every feature uses
    fs-plan.ts                "plan, then write": create / update / unchanged / conflict, never delete
    json-config.ts            edit a user's JSON config without overwriting it
    text-block.ts             keep a managed block inside a user's text file (.gitignore)
    config.ts, agents.ts      the settings schema and the list of agents
  features/
    rules/                    agent-rules/ -> AGENTS.md, CLAUDE.md, GEMINI.md, per-agent rule files
    hooks/                    the guard (guard.mjs), the test corpus, approval, audit log
    agents/                   per-agent hook config: claude, cursor, codex, qoder, antigravity
    git/                      git hooks and git-checks.mjs (secrets, dependencies, force pushes)
    github/                   templates, CODEOWNERS, CI workflow, branch-protection command
    secrets/, dependencies/   thin wrappers over the checks in git-checks.mjs
    presets/, package-manager/ presets, stacks, npm/pnpm/yarn/bun detection
    setup/                    builds the whole install plan; applies it
    doctor/                   the diagnosis behind `doctor`
    explain/, prompts/        plain-language reasons; the red-team and gap-review prompts
    dashboard/                the read-only Fastify page
    commands/                 one file per CLI command, plus the Ui interface
tests/helpers/                in-memory project, scripted Ui, fake DOM
scripts/build.mjs             bundles dist/cli.mjs with esbuild
```

## Two files run outside the CLI

`src/features/hooks/guard/guard.mjs` and `src/features/git/git-checks/git-checks.mjs` are copied into the user's project (`.agent-guardrails/`) and run by agents and by git. So they are **plain JavaScript with no dependencies**, and each refuses to start itself unless it is running under its own file name (so bundling it into the CLI does not run it). A test bundles them and runs the result.

## The flow of an action

1. An agent is about to run a tool. Its hook calls `guard.mjs` with the tool call as JSON on stdin.
2. `normalizeRequest` turns Claude, Cursor, Codex and Qoder payloads into one shape.
3. For shell commands the lexer splits the text into commands (handling quotes, `$(...)`, pipes and here-documents), wrappers are unwrapped, and each command is classified: hard block, ask, or allow. For files, paths are checked against the project folder, secrets and protected files, and the plan gate.
4. The answer is written in the format the calling agent expects. Any crash is a block.

## Rules of the house

- **Never delete.** The planner only creates or updates. Removing something is always left to the person.
- **Fail closed.** Errors in the guard, the hooks and the checks block instead of allow.
- **Ask before writing.** `init`, `update`, `sync`, `preset`, `allow` and `approve` show what they will do first.
- **Agents cannot change the guardrails.** The guard protects its own files and blocks agents from running the state-changing commands.
- **Everything is tested against the real thing**: the guard as a separate process, the hook commands through a real shell, git hooks with real git (in temp folders), and the built CLI as a subprocess.

## How to add things

- **A guard rule.** Add the check in `guard.mjs`, give it a rule id, add that id to `src/features/explain/catalog.ts` (a test fails until you do), and add cases to `src/features/hooks/corpus/` (a hard block needs a `deny` case, which also runs under permissive settings).
- **A red-team probe.** Add it to `src/features/prompts/probes.ts`. A test checks its expected result against the guard.
- **An agent.** Add `src/features/agents/<agent>.ts` returning an `AgentPlan`, register it in `plan.ts`, `detect.ts` and `shared/agents.ts`, and verify its hook format against its documentation first.
- **A command.** Add `src/features/commands/<name>.ts`, register it in `src/program.ts`, document it in the README (a test checks that every command is mentioned).

## Tests

`pnpm test` runs everything (about 40 seconds). The slow parts are the guard-as-a-process tests; set `FULL_CORPUS=1` to run every corpus case that way instead of a sample. Tests that need git or a shell create throwaway folders under the system temp directory and leave them; nothing in the kit deletes files.
