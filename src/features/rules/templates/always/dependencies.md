---
description: Ask before adding, removing or updating dependencies. Always apply.
---

# Dependencies

- Ask before you add, remove or update any package. Say the package name, what it is for, and why the standard library or an existing dependency is not enough.
- Check the exact spelling. AI tools sometimes invent package names or misspell real ones, and attackers register look-alike names. If you are not sure a package exists, say so instead of guessing.
- Prefer well-known, maintained packages. Do not install from git URLs, tarball links or local paths without approval.
- Never add or change install scripts (`preinstall`, `install`, `postinstall`, `prepare`) that delete files or download and run code.
- Use the project's package manager (check the lockfile) and keep the lockfile in the same change as `package.json`.
