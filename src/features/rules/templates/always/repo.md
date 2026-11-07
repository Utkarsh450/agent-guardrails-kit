---
description: Project boundaries and feature-based folder structure. Always apply.
---

# Project boundaries

- Work only inside this project folder, and inside the folder of the feature the task is about.
- Use a feature-based structure. Code, tests, templates and docs for one feature live together in that feature's folder (for example `src/features/<feature>/`). Do not add type-based top-level folders such as `controllers/` or `utils/` without approval.
- Do not edit another feature's files unless the approved plan says so.
- If a subfolder has its own project, go into it and follow its own config and package manager (check the lockfile).
- Do not assume a file or folder exists. Check first.
- Do not edit generated or vendored output: `dist/`, `build/`, `node_modules/`, copied reference folders.
