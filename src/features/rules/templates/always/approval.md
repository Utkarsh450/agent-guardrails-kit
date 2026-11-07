---
description: Plan first, get the user's approval, then act. Ask before running anything. Always apply.
---

# Plan, then approval

1. For every feature or change, make a plan first (plan mode, or a `PLAN.md` file). Do not create, edit, move or delete any file before the user approves the plan.
2. Use auto mode only after the plan is approved. Plan mode first, then auto mode, never the other way round.
3. After approval, do only what the approved plan covers. Anything outside it needs a new approval.
4. Ask before running any command that is not read-only. Say the exact command and the reason, then wait for a yes. A yes covers that one command only.
5. Read-only commands are fine without asking: `ls`, `cat`, `grep`, `find` (without delete or exec flags), `git status`, `git diff`, `git log`, `git show`.
6. Ask one clear question at a time. Do not stack options.
7. When the work is done, say what changed and what was not verified.
