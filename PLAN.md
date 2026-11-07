# Plan: update the README

The previous feature plans are done and pushed. This file replaces them and is the record the guard's approval gate needs.

## Goal

Make `README.md` honest and easier for a new person on GitHub. Two changes only.

## Change 1: Install section (Quick start)

Problem: the Quick start says `npx agent-guardrails-kit init`. The package is not on npm yet, so that command fails for a visitor.

What I will do:
- Keep the three `npx` / `pnpm dlx` / `bunx` commands, but move them under a heading "After it is published to npm", with one line saying it is not published yet.
- Add a section "Install from GitHub (works today)" with these steps. Each step says what it does:
  1. `git clone <this repository URL>` and `cd` into it (copies the code).
  2. `pnpm install` then `pnpm build` (installs dependencies and builds `dist/cli.mjs`).
  3. In your own project folder: `node /path/to/agent-guardrails-kit/dist/cli.mjs init` (sets up the guard there).
- Keep the lines that use `agent-guardrails doctor` and the `test` commands.
- The clone URL: I will use `https://github.com/Utkarsh450/agent-guradrails-kit.git`, exactly as the repository is spelled today (it has a typo). If you rename the repository, that one line needs updating. No placeholder is left in the README.

## Change 2: "Try it safely first" section

Add a new section after "Quick start". It tells a person how to test in a throwaway folder before trusting it:

| Step | Command | What it does |
|---|---|---|
| 1 | `mkdir guardrails-sandbox`, `cd guardrails-sandbox`, `git init` | New empty test folder |
| 2 | `agent-guardrails init --dry-run` | Only shows the files it would create |
| 3 | `agent-guardrails init` | Sets up the guard in the sandbox after your yes |
| 4 | `agent-guardrails doctor` and `agent-guardrails test --hooks` | Shows what is protected and proves the guard blocks without any agent |
| 5 | `agent-guardrails alerts --notify` in a second terminal tab | Live view of blocked and asked actions |
| 6 | `agent-guardrails test --prompt`, then paste the printed prompt into your agent, opened in the sandbox | A real test: the agent tries to delete, push, write outside the folder and so on |

It also adds a short table "What to look for": blocked actions appear as `BLOCKED` in the alerts tab; a plan must be approved with `agent-guardrails approve` before file changes; `agent-guardrails checkpoints` lists saved copies; `agent-guardrails mode watch` lets unknown commands run and logs them while hard blocks stay blocked.

## Files

| File | Change |
|---|---|
| `README.md` | Edited as above. Nothing else is touched |
| `PLAN.md` | This plan |

No code, no tests, no dependencies, no generated files change. `AGENTS.md` and `CLAUDE.md` are not affected.

## Checks I will do (read-only)

- Read the finished README back and check that every command named exists in `src/program.ts` (so the README does not describe commands that are missing).
- Check that `tests/` has no test that compares README text (a docs test exists for LIMITS.md, so I will look at it). If one does, I will tell you before changing anything else.
- I will not run the test suite; you can run `pnpm test` if you want it checked.

## Not part of this plan

- Nothing is committed or pushed. After I finish, you run `git add README.md PLAN.md`, `git commit` and `git push` yourself. GitHub shows the new README after the push.
- No CI badge, no repository rename, no package name decision.
