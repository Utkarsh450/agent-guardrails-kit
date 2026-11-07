---
description: Database, migration and SQL files. Read-only by default.
globs:
  - "**/migrations/**"
  - "**/*.sql"
  - "**/prisma/**"
  - "**/drizzle/**"
---

# Database work

- Read-only queries (`SELECT`, `EXPLAIN`) are fine. Any other statement needs approval first.
- Never run a migration yourself. Write the migration file after the plan is approved, and let the user run it.
- Do not write destructive statements (`DROP`, `TRUNCATE`, `DELETE`) into migrations or scripts. Describe the need to the user and let them write it.
- Never point a script at a production database. Ask which database a command targets before running it.
- Test cleanup counts as a database write. Ask first.
