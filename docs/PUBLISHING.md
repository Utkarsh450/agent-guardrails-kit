# Publishing it yourself

You run every step on this page yourself, in your own terminal. The kit's own rules stop AI agents from doing git, GitHub or npm publishing for you, so do not hand these steps to one.

Replace `OWNER` and `REPO` with your GitHub user or organisation and the repository name.

## 0. Decide and fill in

- **The package name.** The placeholder is `agent-guardrails-kit`. Check it is free:

  ```bash
  npm view agent-guardrails-kit name
  ```

  A "404" means it is free. To use a different name, change it in one place; the startup banner and the CI step follow `package.json`:

  ```bash
  npm pkg set name=your-package-name
  ```

  Then replace the old name in `README.md`, `docs/` and `SECURITY.md` (search for it first: `grep -rn "agent-guardrails-kit" README.md docs SECURITY.md`). The command name (the one entry in `bin`) is separate. It is `agent-guardrails-kit` on purpose: the bare `agent-guardrails` belongs to a different npm package, so this kit does not install it.
- **LICENSE:** replace `<YOUR NAME OR ORGANISATION>` with your name.
- **SECURITY.md:** add your private contact, or rely on GitHub's private vulnerability reporting (turn it on in step 2).

## 1. Check that it works

```bash
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

See exactly what would be published:

```bash
npm pack --dry-run
```

It should list only `dist/cli.mjs`, `package.json`, `README.md` and `LICENSE`. If anything else appears, stop and look.

## 2. Put it on GitHub

```bash
git init -b main
```

```bash
git add -A
```

Read this list before you commit. It should contain only source, docs and config, never `node_modules/`, `dist/` or a `.env`:

```bash
git status
```

```bash
git commit -m "Initial commit"
```

Create the repository on github.com (public or private), or with the GitHub CLI:

```bash
gh repo create OWNER/REPO --public --source . --remote origin
```

```bash
git push -u origin main
```

Then on GitHub:

1. **Settings, Code security:** turn on private vulnerability reporting.
2. **Actions:** the workflow in `.github/workflows/ci.yml` runs on the first push. Read its result. The Windows jobs are an experiment and are allowed to fail.
3. **Branch protection** (no force pushes, required checks): the kit prints the command with your values to fill in:

   ```bash
   node dist/cli.mjs explain branch-protection
   ```

Add the repository details to the package, so npm links to it:

```bash
npm pkg set repository.type=git repository.url=git+https://github.com/OWNER/REPO.git homepage=https://github.com/OWNER/REPO#readme bugs.url=https://github.com/OWNER/REPO/issues
```

## 3. Publish to npm

Log in (use an account with two-factor authentication on):

```bash
npm login
```

The package is marked `"private": true` so it cannot be published by accident. Remove that, and set the first version:

```bash
npm pkg delete private
```

```bash
npm version 0.1.0 --no-git-tag-version
```

Practise first. This does everything except upload:

```bash
npm publish --dry-run
```

Then publish for real:

```bash
npm publish --access public
```

`prepublishOnly` runs the type check, the tests and the build first, so a broken build cannot go out. Be careful: a published version cannot be replaced, and unpublishing is restricted after a short time.

Commit the version bump and tag it:

```bash
git commit -am "Release 0.1.0"
```

```bash
git tag v0.1.0 && git push --follow-tags
```

## 4. Try it as a stranger

In a new empty folder:

```bash
cd "$(mktemp -d)" && git init && npx agent-guardrails-kit@latest init
```

Check that the plan makes sense, that nothing is written before you say yes, and that `agent-guardrails-kit doctor` is happy afterwards.

## 5. Share it

People need to run one command in their project:

```bash
npx agent-guardrails-kit init
```

Put that line and a link to the README wherever you share it. Tell people to run `agent-guardrails-kit doctor` and `agent-guardrails-kit test --prompt` afterwards, and to read [docs/LIMITS.md](LIMITS.md): the honest list of what this does not stop is part of the product.

Once the package is published (the version is no longer `0.0.0`), `init` also writes a CI step that runs `agent-guardrails-kit doctor --ci` from that exact version.

## 6. Releasing updates

1. Make the change with a test for it (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
2. `pnpm test`, then `npm version patch` (or `minor`), then `git push --follow-tags`, then `npm publish`.
3. Tell users to run `agent-guardrails-kit update`. It refreshes the generated files, shows the diff first, and never overwrites their own files. Codex users must trust the changed hook again (`/hooks`).
