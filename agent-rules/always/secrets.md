---
description: Never read, print, copy or commit secrets. Always apply.
---

# Secrets

- Do not open `.env` files, private keys, tokens or credential files, and do not print their values. Refer to variables by name. `.env.example` is fine to read and edit.
- Never put a real key, token or password in code, tests, docs, logs or commit messages. Use environment variables and placeholders such as `your-api-key-here`.
- Do not search for secrets with recursive searches (`grep -r`, `rg --hidden`, `find -exec cat`) over folders that hold `.env` files. Search specific folders, or exclude them (`--exclude='.env*'`).
- If you find a secret in the project, do not repeat its value. Tell the user where it is (file and line) so they can rotate it.
- A test or example needs a fake credential? Build it from placeholders. If a scanner flags a line you know is fake, ask the user before adding the `agent-guardrails:allow-secret` marker.
