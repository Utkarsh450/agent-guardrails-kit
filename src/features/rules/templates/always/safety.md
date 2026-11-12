---
description: Never delete, never touch git history or GitHub, never leave the project folder, never weaken the guardrails. Always apply.
---

# Hard limits

If a task needs one of these, do not do it. Tell the user the exact command and why, and let the user run it.

## Never run

- **File deletion:** `rm`, `rmdir`, `unlink`, `find -delete`, `git clean`, moving files to the trash, or any script that deletes (`os.remove`, `shutil.rmtree`, `fs.rm`, and similar).
- **Database deletes:** `DELETE`, `DROP`, `TRUNCATE`, or any command that removes data. Any other database write needs approval first (see the approval rule). Read-only queries (`SELECT`, `EXPLAIN`) are allowed.
- **Git changes:** only `git status`, `git diff`, `git log` and `git show` are allowed. Never `add`, `commit`, `push`, `pull`, `fetch`, `checkout`, `switch`, `reset`, `rebase`, `merge`, `stash`, `tag`, `branch` changes or `init`. Never use `--no-verify`. Never change `core.hooksPath`.
- **GitHub:** never run `gh` commands or call the GitHub API.
- **Publishing and deploys:** never `npm publish`, `docker push`, deploy commands or anything that sends code to another place.
- **Processes:** do not kill or restart a process without asking first.
- **The guardrails' own commands:** never run `agent-guardrails-kit init`, `update`, `sync`, `approve`, `allow`, `preset`, `mode`, `alerts`, `restore` or `ui`. They change the approval record, the allowed commands and the guardrail files, and only the user may run them. Never approve your own plan.

## Stay inside this folder

Do not read, write or run anything outside this project folder. That includes `~`, `/etc`, parent folders and other projects.

## Files you must not change

Do not edit, move or delete these unless the user explicitly asks in this turn:

- the rule sources in `agent-rules/`
- `.agent-guardrails/`
- `.githooks/`
- `.claude/settings.json`, `.cursor/hooks.json`, `.codex/`
- `.git/`
- `.env` files (do not read their values either)

`AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and the per-agent rule folders are generated. Edit the source in `agent-rules/` and ask the user to run `agent-guardrails-kit sync`.

Do not add a package lifecycle script (`preinstall`, `postinstall`, `prepare`) that deletes files or runs network commands.
