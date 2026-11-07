# Plan: five features, built one at a time

Each feature is its own commit (you run git), and I pause after each one for review.
This file is the record the guard's approval gate needs. Only the feature marked "this approval" is covered.

- Features 1 to 4 (watch mode, live alerts, script scanning, checkpoints): DONE (930 tests pass). Waiting for your commit.
- Feature 5, shared team presets: this approval. It is the last one.

## Feature 5: Shared team presets (this approval covers only this)

Goal: a team or company writes its guard settings once, and every project uses them, without copying settings by hand and without the settings drifting apart.

### How it works for a person
1. In a project that is set up the way the team wants: `agent-guardrails preset export team-preset.json` writes a small, checked preset file (name, description, settings). It only reads the project and writes that one file.
2. The team shares the file: commit it, copy it, or publish it as an npm package that has `guardrails-preset.json` at its root.
3. In any other project: `agent-guardrails preset use ./team-preset.json` or `agent-guardrails preset use @acme/guardrails-preset`. It shows the exact settings change as a diff, asks, and saves the choice as `"extends"` in `agent-guardrails.config.json`.
4. `agent-guardrails update` re-reads the source and applies it again, so projects follow the team when the preset changes. If the source is missing or invalid, update stops with a clear error. It never skips it silently.
5. `agent-guardrails doctor` says which preset is in use, whether it changed since it was applied, and fails if the source cannot be read or is invalid.

### What a preset can and cannot do
A preset file holds only these settings: `policy`, `allowCommands`, `gitAllow`, `approvalGate`, `auditAllowed`, `alwaysRuleFiles`, `checkpoints`. Any other key (`mode`, `watchUntil`, `agents`, `stack`, `extends`, ...) makes the file invalid.

It can only keep or raise protection, never lower it:
- `policy`: "ask" or "allowlist" only. Never "blocklist". If the project already has the stricter one, it stays.
- `approvalGate`: must be true.
- `auditAllowed`, `alwaysRuleFiles`, `checkpoints`: true wins over false. A preset cannot switch a project's own logging or checkpoints off.
- `gitAllow`: only the read-only git commands the kit already knows (`status`, `diff`, `log`, `show`, `ls-files`, ...). Anything else is refused.
- `allowCommands`: refused if an entry starts with `*`, is a broad program (`sh`, `bash`, `node`, `python`, `env`, `find`, ...), is always blocked, or would still ask. This is the same test `allow add` already applies.
- Hard blocks never change. A preset cannot allow `rm`, `git push`, `gh` or `.env` reads.

### How settings are combined (decision for you)
- A project keeps everything it has; the preset adds to it. `allowCommands` and `gitAllow` are joined, so the project's own entries stay.
- Consequence: if the team later removes a command from the preset, projects that already received it keep it until someone removes it by hand. `doctor` does not catch this. The alternative (tracking which entries came from the preset) is more code and more ways to go wrong; I recommend the simple version and writing it down.
- The merged result is written into `agent-guardrails.config.json`. The guard still reads only that one file and is NOT changed.
- `"extendsHash"` (a fingerprint of the preset settings) is saved with it, so `doctor` can see that the source changed.

### Where a preset can come from (decision for you)
- A file inside the project folder (no `..`, no absolute path), up to 64 KB.
- An npm package already installed in `node_modules` (`name` or `@scope/name`). The kit reads `node_modules/<name>/guardrails-preset.json`. It never installs anything and never uses the network.
- Not allowed: URLs, git addresses, files outside the project, symlinks that leave the project. Your own rules say dependencies need a person's approval, so installing the package stays your job.
- A preset is trusted input: whoever controls the package or file controls those settings. That is why `use` shows the full diff and asks, and why the limits above exist. I will say this in `docs/LIMITS.md`.

### Other behaviour
- `agent-guardrails preset team` (the built-in presets) keeps working. Switching to a built-in preset removes `extends`, and says so.
- `preset export` refuses to overwrite an existing file that is different.
- `preset use` and `preset export` are user-only: the guard already blocks agents from `preset` (no guard change needed for that).
- `agent-guardrails preset <name> [target]` is the one command; `export` and `use` are the two new words. The built-in names (`learner`, `balanced`, `team`) are unchanged.

### Files (all inside this project)
- `src/shared/config.ts`: two CLI-only settings, `extends` and `extendsHash`.
- New `src/features/team-presets/`: the preset file format, source resolving (file or `node_modules` package, with the path and symlink checks), the combining rules, export, fingerprint, and tests.
- `src/features/commands/preset.ts`: `export` and `use`; built-in switch clears `extends`.
- `src/features/setup/plan.ts` and `src/features/commands/update.ts`: `update` applies the preset to the settings file in the same reviewed plan as everything else.
- `src/features/commands/allow.ts` and `src/features/doctor/index.ts`: the "broad programs" list that both already keep separately moves to one shared place; doctor gets the preset checks.
- `src/program.ts` and `src/program.test.ts`: `preset <name> [target]` with `--name` and `--description` for export.
- `README.md` (a short "share one setup" section and a table row) and `docs/LIMITS.md`.
- No change to `guard.mjs`.

### How it will be checked
- Unit tests: a valid file; every refused key and value; the four combining directions (stricter project stays, preset adds, true wins, joined lists); each refused `allowCommands` kind; source resolving for a file, a package, a scoped package and a pnpm-style symlinked package; refused `..`, absolute paths, URLs, git addresses, symlinks out of the project and oversized files; export round trip (export then use gives the same settings); `update` applies a changed preset and stops on a missing one; built-in switch clears `extends`; doctor reports in-use, changed, missing and invalid.
- `pnpm typecheck`, `pnpm test`, `pnpm build`, and `agent-guardrails test --hooks` still at 100% in process.
- A manual check you can do without an agent: export from one sandbox project and use it in a second one.

## Rules for the build
Work only in this folder. No git except status, diff, log and show. No deletions. You run every commit.
