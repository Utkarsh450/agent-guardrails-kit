import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * A POSIX shell to run hook commands in, the way the agents do. Claude Code runs hooks through a shell, and on
 * Windows that is Git Bash, so tests look for Git's own sh.exe instead of assuming /bin/sh.
 */
export function posixShell(): string {
  if (process.platform !== "win32") return "/bin/sh";
  const found = spawnSync("where", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/).find((line) => line.trim() !== "");
  const candidates = [
    ...(found ? [path.join(path.dirname(path.dirname(found.trim())), "bin", "sh.exe")] : []),
    "C:\\Program Files\\Git\\bin\\sh.exe",
    "C:\\Program Files (x86)\\Git\\bin\\sh.exe",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "sh";
}

/** False only on a Windows machine without Git Bash, where tests that run hooks through a shell cannot run. */
export const hasPosixShell = process.platform !== "win32" || posixShell() !== "sh";