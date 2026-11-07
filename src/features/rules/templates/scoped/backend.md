---
description: Server, API and route code.
globs:
  - "**/server/**"
  - "**/api/**"
  - "**/routes/**"
---

# Backend

- Use the package manager the project already uses (check the lockfile). Do not switch between `npm`, `pnpm` and `bun`.
- Validate input at the boundary. Never trust request data.
- Keep secrets out of code, logs and responses. Read them from the environment.
- Run one server at a time. Start it, test it, then ask the user before stopping it.
- Do not kill a process yourself.
