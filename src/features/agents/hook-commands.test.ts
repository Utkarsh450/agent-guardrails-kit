import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasPosixShell, posixShell } from "../../../tests/helpers/shell.ts";
import { guardSource } from "../hooks/install.ts";
import { GUARD_PATH, commands } from "./constants.ts";

/**
 * These tests run the exact command lines written into each agent's config through a real shell,
 * the way the agents do. They prove the paths resolve, quoting survives spaces, and (most important)
 * that a missing or broken guard BLOCKS instead of silently allowing.
 * Temp folders are left for the OS to clean up: the kit's rules forbid deleting files.
 */

async function project(name = "project"): Promise<string> {
  const holder = await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-hook-"));
  const root = path.join(holder, name);
  await mkdir(path.join(root, ".agent-guardrails"), { recursive: true });
  await writeFile(path.join(root, GUARD_PATH), guardSource, "utf8");
  return realpath(root);
}

async function emptyProject(): Promise<string> {
  const holder = await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-noguard-"));
  return realpath(holder);
}

interface Run {
  command: string;
  cwd: string;
  payload: unknown;
  env?: Record<string, string>;
}

function runHook({ command, cwd, payload, env = {} }: Run) {
  const result = spawnSync(posixShell(), ["-c", command], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, AGENT_GUARDRAILS_NO_AUDIT: "1", ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const bash = (command: string, cwd: string) => ({ tool_name: "Bash", tool_input: { command }, cwd });

describe.skipIf(!hasPosixShell)("hook command lines, run through a real shell", () => {
  describe("Claude Code", () => {
    it("blocks a dangerous command and lets a safe one through", async () => {
      const root = await project();
      const env = { CLAUDE_PROJECT_DIR: root };
      expect(runHook({ command: commands.claude, cwd: root, env, payload: bash("rm -rf x", root) }).code).toBe(2);
      expect(runHook({ command: commands.claude, cwd: root, env, payload: bash("git status", root) })).toMatchObject({ code: 0, stdout: "" });
    });

    it("works from a subfolder and in a project path with spaces", async () => {
      const root = await project("my project (v2)");
      await mkdir(path.join(root, "src"), { recursive: true });
      const env = { CLAUDE_PROJECT_DIR: root };
      const out = runHook({ command: commands.claude, cwd: path.join(root, "src"), env, payload: bash("rm x", path.join(root, "src")) });
      expect(out.code).toBe(2);
      expect(out.stderr).toContain("file-deletion");
    });

    it("FAILS CLOSED when the guard file is missing", async () => {
      const root = await emptyProject();
      const out = runHook({ command: commands.claude, cwd: root, env: { CLAUDE_PROJECT_DIR: root }, payload: bash("ls", root) });
      expect(out.code).toBe(2);
    });

    it("FAILS CLOSED when node cannot be found", async () => {
      const root = await project();
      const out = runHook({ command: commands.claude, cwd: root, env: { CLAUDE_PROJECT_DIR: root, PATH: "/nonexistent" }, payload: bash("ls", root) });
      expect(out.code).toBe(2);
    });

    it("shows why the wrapper exists: without it a missing guard is a harmless-looking exit 1", async () => {
      const root = await emptyProject();
      const bare = `node "${path.join(root, GUARD_PATH)}" --agent claude`;
      expect(runHook({ command: bare, cwd: root, payload: bash("ls", root) }).code).toBe(1);
    });
  });

  describe("Qoder", () => {
    it("blocks and allows, and fails closed", async () => {
      const root = await project();
      const env = { QODER_PROJECT_DIR: root };
      expect(runHook({ command: commands.qoder, cwd: root, env, payload: bash("git push", root) }).code).toBe(2);
      expect(runHook({ command: commands.qoder, cwd: root, env, payload: bash("ls", root) }).code).toBe(0);
      const empty = await emptyProject();
      expect(runHook({ command: commands.qoder, cwd: empty, env: { QODER_PROJECT_DIR: empty }, payload: bash("ls", empty) }).code).toBe(2);
    });

    it("is not unlocked by an unset project variable (it blocks instead)", async () => {
      const root = await project();
      const env = { QODER_PROJECT_DIR: "" };
      expect(runHook({ command: commands.qoder, cwd: root, env, payload: bash("ls", root) }).code).toBe(2);
    });
  });

  describe("Cursor", () => {
    it("answers in Cursor's JSON format from the project root", async () => {
      const root = await project();
      const allow = runHook({ command: commands.cursor, cwd: root, payload: { command: "ls", cwd: root, hook_event_name: "beforeShellExecution" } });
      expect(allow.code).toBe(0);
      expect(JSON.parse(allow.stdout)).toEqual({ permission: "allow" });

      const deny = runHook({ command: commands.cursor, cwd: root, payload: { command: "rm x", cwd: root, hook_event_name: "beforeShellExecution" } });
      expect(deny.code).toBe(2);
      expect(JSON.parse(deny.stdout).permission).toBe("deny");
    });

    it("exits non-zero when the guard is missing (Cursor's failClosed then blocks)", async () => {
      const root = await emptyProject();
      const out = runHook({ command: commands.cursor, cwd: root, payload: { command: "ls", cwd: root } });
      expect(out.code).not.toBe(0);
    });
  });

  describe("Codex", () => {
    it("finds the guard from any folder inside the project", async () => {
      const root = await project("codex project");
      const deep = path.join(root, "packages", "app", "src");
      await mkdir(deep, { recursive: true });
      for (const cwd of [root, path.join(root, "packages"), deep]) {
        const blocked = runHook({ command: commands.codex, cwd, payload: bash("rm -rf x", cwd) });
        expect(blocked.code, cwd).toBe(2);
        expect(blocked.stderr).toContain("file-deletion");
        expect(runHook({ command: commands.codex, cwd, payload: bash("ls", cwd) })).toMatchObject({ code: 0, stdout: "" });
      }
    });

    it("turns an ask into a deny, because Codex cannot ask", async () => {
      const root = await project();
      const out = runHook({ command: commands.codex, cwd: root, payload: bash("python script.py", root) });
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/Codex cannot prompt/);
    });

    it("FAILS CLOSED when no guard exists above the working folder", async () => {
      const root = await emptyProject();
      expect(runHook({ command: commands.codex, cwd: root, payload: bash("ls", root) }).code).toBe(2);
    });

    it("FAILS CLOSED when node cannot be found", async () => {
      const root = await project();
      const out = runHook({ command: commands.codex, cwd: root, env: { PATH: "/nonexistent" }, payload: bash("ls", root) });
      expect(out.code).toBe(2);
    });

    it("handles apply_patch payloads", async () => {
      const root = await project();
      const payload = { tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch" }, cwd: root };
      expect(runHook({ command: commands.codex, cwd: root, payload }).code).toBe(2);
    });
  });
});
