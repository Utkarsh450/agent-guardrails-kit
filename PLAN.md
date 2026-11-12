# Plan: make the messages and docs true before publishing

The previous plan (fewer interruptions) is done. This file replaces it and is the record the guard's approval gate needs. It covers two problems found while testing: a wrong "hooks reload on their own" note, and a command name that collides with another npm package.

## Problem 1: hooks and new sessions

1. In `test-app1` a Claude Code session in the VS Code extension blocked nothing, although `/hooks` listed the project hooks.
2. In `test-app4`, after `init` was run again with Claude Code ticked and a NEW session was opened, the same extension blocked writes and deletes. So the extension does run the hook.
3. Most likely cause of (1): Claude Code reads hooks when a session starts, and `init` ran after that session was already open. This fits the evidence but is not proven.
4. `init` says "Claude Code reloads hooks on its own". That is the opposite of what the evidence suggests.

## Problem 2: the command name

1. `agent-guardrails` already exists on npm as a different project (v0.21.0). `agent-guardrails-kit` is free.
2. `package.json` installs two commands, `agent-guardrails` and `agent-guardrails-kit`. Anyone who runs `npx agent-guardrails` gets the other project, and two global installs fight over the bare command.
3. A person who only used `npx agent-guardrails-kit init` has no bare `agent-guardrails` command at all, yet every message and the README tell them to type it.

## Changes

| # | Change | Where |
|---|---|---|
| 1 | `init` note for Claude Code: start a NEW Claude Code session in this folder after init (hooks are read when a session starts), then check once by asking Claude to create a file and expecting it to stop at the plan gate. `agent-guardrails-kit test --prompt` is the full check. Keep the Node-on-PATH and commit notes. | `src/features/agents/claude.ts` |
| 2 | One command name: `agent-guardrails-kit`. `package.json` keeps only that bin. Every message, prompt, doc and rule text that tells a person to run `agent-guardrails <command>` says `agent-guardrails-kit <command>` instead. | about 54 files, see below |
| 3 | README: a Troubleshooting row "The agent ignored the guard" (new session, Claude Code ticked in `init`, run the test prompt); one sentence under "Which agents are really protected" (enforced means the hook is installed, the test prompt shows it running); how to run it (`npm install -g agent-guardrails-kit`, or put `npx` in front); one line saying it is not related to the `agent-guardrails` package on npm. | `README.md` |
| 4 | `docs/LIMITS.md`: hooks are read at session start, so a session opened before `init` or `update` does not use them; hooks-not-firing reports exist for some Claude Code setups on Windows that I did not reproduce. | `docs/LIMITS.md` |

### How change 2 is done

- A text replace of `agent-guardrails <subcommand>` to `agent-guardrails-kit <subcommand>` (subcommands: init, update, doctor, approve, allow, sync, preset, mode, alerts, report, checkpoints, restore, explain, test, ui), across `src`, `docs`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `scripts` and `.github`. About 248 places in 54 files.
- I review the result with `git diff` and a search for leftovers. Prose mentions of the bare name are fixed by hand.
- NOT renamed, because they are file or folder names or markers, not commands: `.agent-guardrails/`, `agent-guardrails.config.json`, `agent-guardrails:generated`, `agent-guardrails:allow-secret`, the `agent-guardrails blocked this` label printed by the guard, and the CI workflow file name.
- The guard keeps recognising both names as the kit's own commands, so agents still cannot run either. Test cases for both names stay.
- Tests that check message text are updated to the new text. Nothing is deleted to make a test pass.

## Not doing

- `"onFailure": "block"` on the hook: needs Claude Code 2.1.295 or newer, unknown on older versions, and it does not help when a hook is never called.
- A doctor check: it cannot see which agent is running or whether a session loaded the hook.
- Changing the agent question or any preset.
- Publishing steps: removing `"private": true`, the version number and the repo rename are yours to decide.

## Effects you should know about

- Projects set up with the old text have the old command name in their generated files until you run `agent-guardrails-kit update` in them. Your test folders are such projects.
- The launcher file you made earlier is called `agent-guardrails.cmd`. You will make an `agent-guardrails-kit.cmd` the same way. The old one can stay.

## Checks

`pnpm run typecheck`, `pnpm test`, `pnpm run build`, then a search showing no `agent-guardrails <subcommand>` left, then `init` and `doctor` run once in a throwaway folder.

## Not part of this plan

Nothing is committed or pushed.
