# Contributing

Thanks for helping. This tool exists to keep people safe, so the bar is "does it still fail safe, and is it proven by a test".

## Setup

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Node 22.12 or newer. The project uses pnpm, but the CI also runs it with npm and bun.

## Rules for changes

1. **A change to the guard needs a corpus case.** Add the command to `src/features/hooks/corpus/` with the outcome it must have. A hard block goes in as `deny`, which also runs under permissive settings.
2. **Every rule id the guard returns needs an entry in the explain catalog.** A test fails until it has one.
3. **Never make anything delete files.** The kit only creates or updates, and the guard blocks deletes. Tests leave their temp folders behind on purpose.
4. **Fail closed.** If you are not sure, block or ask.
5. **Test the real thing.** If you add a hook, run the generated command through a real shell. If you add a command, drive it through the built CLI.
6. **Check formats against the agent's own documentation**, and say in the pull request which page you read. Hook formats change.
7. Keep user-facing text short and in plain words. Say who acts and whether a step changes anything.

## Pull requests

Use the template. Say what changed, why, and how you checked it. If an AI agent helped, say which, and read the whole diff yourself before asking for review.

## Reporting a bypass

Do not open a public issue. See [SECURITY.md](SECURITY.md).
