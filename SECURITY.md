# Security

This project is a safety tool, so a way around it is a real bug.

## What counts

Please report any of these:

- A command, file edit or tool call that the guard should block (see [docs/LIMITS.md](docs/LIMITS.md) for what it deliberately does not cover) but lets through, in the default settings or with an `allowCommands` list.
- A way for an agent to approve its own plan, change the allowed commands, edit the guard or its settings, or turn the hooks off.
- A way to read or write outside the project folder, or to read a secret file.
- A way for a web page or another program to make the dashboard change something, or to reach it from outside the machine.
- A bug that makes the installer overwrite or delete a file it did not create.

## How to report

Do **not** open a public issue for a bypass. Use GitHub's private vulnerability reporting on this repository ("Security" tab, then "Report a vulnerability"). Turn it on in the repository settings before the first release.

Include the exact command or payload, the agent and settings you used, and what you expected. A failing test case for `src/features/hooks/corpus/` is ideal.

## What to expect

This is a small project, so there is no guaranteed response time. Reports of bypasses are taken seriously and fixed with a regression test before a release.

## Supported versions

Only the latest release gets fixes.
