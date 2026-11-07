import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../shared/agents.ts";
import { applyPlan, diskReadExisting, type PlannedFile } from "../../shared/fs-plan.ts";
import { planGitFiles } from "../git/index.ts";
import { planGithubFiles } from "../github/index.ts";
import { planGuardFiles } from "../hooks/install.ts";
import { applySync, defaultRuleSources, diskSyncIo, planSync } from "../rules/index.ts";
import { planAgents } from "./plan.ts";

/**
 * Installs everything into a real temp project, then reads the hook commands back out of the config files
 * that were actually written and runs them. Temp folders are left for the OS to clean up (no deleting).
 */

async function installAll(userFiles: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-e2e-")));
  for (const source of defaultRuleSources) {
    const abs = path.join(root, "agent-rules", ...source.path.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, source.content, "utf8");
  }
  for (const [rel, content] of Object.entries(userFiles)) {
    const abs = path.join(root, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  const read = diskReadExisting(root);
  const rules = await planSync(diskSyncIo(root), { agents: AGENT_IDS });
  const guard = await planGuardFiles(read);
  const agents = await planAgents(read, AGENT_IDS);
  const git = await planGitFiles(read);
  const github = await planGithubFiles(read);
  const all: PlannedFile[] = [...rules.files, ...guard, ...agents.flatMap((plan) => plan.files), ...git, ...github];
  await applyPlan(root, all);
  return { root, all, rules, guard, agents };
}

const bash = (command: string, cwd: string) => ({ tool_name: "Bash", tool_input: { command }, cwd });

function run(command: string, cwd: string, payload: unknown, env: Record<string, string>) {
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, AGENT_GUARDRAILS_NO_AUDIT: "1", ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function hookCommand(root: string, file: string, pick: (config: any) => string): Promise<string> {
  return pick(JSON.parse(await readFile(path.join(root, file), "utf8")));
}

describe.skipIf(process.platform === "win32")("install into a project, then run what was written", () => {
  it("writes every expected file and reports no conflicts in a fresh project", async () => {
    const { all } = await installAll();
    expect(all.filter((file) => file.status === "conflict")).toEqual([]);
    const paths = all.map((file) => file.path);
    for (const expected of [
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      ".agent-guardrails/guard.mjs",
      "agent-guardrails.config.json",
      ".claude/settings.json",
      ".cursor/hooks.json",
      ".codex/hooks.json",
      ".qoder/settings.json",
      ".cursor/rules/database.mdc",
      ".agents/rules/database.md",
      ".qoder/rules/database.md",
      ".githooks/pre-commit",
      ".githooks/pre-push",
      ".agent-guardrails/git-checks.mjs",
      ".gitignore",
      ".github/pull_request_template.md",
      ".github/workflows/agent-guardrails.yml",
      ".github/CODEOWNERS",
    ]) {
      expect(paths, expected).toContain(expected);
    }
  });

  it("a second install changes nothing", async () => {
    const { root } = await installAll();
    const read = diskReadExisting(root);
    const again = [
      ...(await planSync(diskSyncIo(root), { agents: AGENT_IDS })).files,
      ...(await planGuardFiles(read)),
      ...(await planAgents(read, AGENT_IDS)).flatMap((plan) => plan.files),
      ...(await planGitFiles(read)),
      ...(await planGithubFiles(read)),
    ];
    expect(again.filter((file) => file.status !== "unchanged")).toEqual([]);
  });

  it("the Claude Code hook written to disk blocks and allows as it should", async () => {
    const { root } = await installAll();
    const command = await hookCommand(root, ".claude/settings.json", (c) => c.hooks.PreToolUse[0].hooks[0].command);
    const env = { CLAUDE_PROJECT_DIR: root };
    expect(run(command, root, bash("rm -rf dist", root), env).code).toBe(2);
    expect(run(command, root, bash("git push", root), env).code).toBe(2);
    expect(run(command, root, bash("git status", root), env).code).toBe(0);
    expect(run(command, root, { tool_name: "Write", tool_input: { file_path: path.join(root, "src/a.ts"), content: "x" }, cwd: root }, env).code).toBe(2);
    expect(run(command, root, { tool_name: "Write", tool_input: { file_path: path.join(root, ".claude/settings.json"), content: "{}" }, cwd: root }, env).stderr).toContain("protected-path");
  });

  it("the Qoder hook written to disk works", async () => {
    const { root } = await installAll();
    const command = await hookCommand(root, ".qoder/settings.json", (c) => c.hooks.PreToolUse[0].hooks[0].command);
    const env = { QODER_PROJECT_DIR: root };
    expect(run(command, root, bash("rm x", root), env).code).toBe(2);
    expect(run(command, root, bash("ls", root), env).code).toBe(0);
  });

  it("the Cursor hooks written to disk work", async () => {
    const { root } = await installAll();
    const shellHook = await hookCommand(root, ".cursor/hooks.json", (c) => c.hooks.beforeShellExecution[0].command);
    const toolHook = await hookCommand(root, ".cursor/hooks.json", (c) => c.hooks.preToolUse[0].command);
    expect(run(shellHook, root, { command: "rm x", cwd: root }, {}).code).toBe(2);
    expect(JSON.parse(run(shellHook, root, { command: "ls", cwd: root }, {}).stdout)).toEqual({ permission: "allow" });
    expect(run(toolHook, root, { tool_name: "Delete", tool_input: { file_path: path.join(root, "a") }, cwd: root }, {}).code).toBe(2);
  });

  it("the Codex hook written to disk works from a nested folder", async () => {
    const { root } = await installAll();
    const command = await hookCommand(root, ".codex/hooks.json", (c) => c.hooks.PreToolUse[0].hooks[0].command);
    const nested = path.join(root, "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(run(command, nested, bash("rm x", nested), {}).code).toBe(2);
    expect(run(command, nested, bash("ls", nested), {}).code).toBe(0);
  });

  it("merges into agent configs the user already has, without losing anything", async () => {
    const existing = {
      ".claude/settings.json": JSON.stringify({ model: "opus", permissions: { allow: ["Bash(pnpm test)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "notify.sh" }] }] } }, null, 2),
      ".cursor/hooks.json": JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "fmt.sh" }] } }),
      "CLAUDE.md": "my own notes",
    };
    const { root, all } = await installAll(existing);

    const claude = JSON.parse(await readFile(path.join(root, ".claude/settings.json"), "utf8"));
    expect(claude.model).toBe("opus");
    expect(claude.permissions.allow).toEqual(["Bash(pnpm test)"]);
    expect(claude.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "notify.sh" }] }]);
    expect(claude.hooks.PreToolUse).toHaveLength(2);

    const cursor = JSON.parse(await readFile(path.join(root, ".cursor/hooks.json"), "utf8"));
    expect(cursor.hooks.afterFileEdit).toEqual([{ command: "fmt.sh" }]);
    expect(cursor.hooks.beforeShellExecution).toHaveLength(1);

    // A hand-written CLAUDE.md is a conflict and is left exactly as it was.
    expect(all.find((file) => file.path === "CLAUDE.md")?.status).toBe("conflict");
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe("my own notes");
  });

  it("leaves a broken agent config untouched and reports it", async () => {
    const { root, all } = await installAll({ ".claude/settings.json": "{ // not json\n}" });
    expect(all.find((file) => file.path === ".claude/settings.json")?.status).toBe("conflict");
    expect(await readFile(path.join(root, ".claude/settings.json"), "utf8")).toBe("{ // not json\n}");
  });

  it("the installed guard stops agents from editing the git hooks, the checks and the CI files", async () => {
    const { root } = await installAll();
    const command = await hookCommand(root, ".claude/settings.json", (c) => c.hooks.PreToolUse[0].hooks[0].command);
    const env = { CLAUDE_PROJECT_DIR: root };
    const write = (file: string) =>
      run(command, root, { tool_name: "Write", tool_input: { file_path: path.join(root, file), content: "x" }, cwd: root }, env);

    for (const file of [".githooks/pre-commit", ".githooks/pre-push", ".agent-guardrails/git-checks.mjs", ".agent-guardrails/guard.mjs"]) {
      expect(write(file).stderr, file).toContain("protected-path");
    }
    for (const file of [".github/workflows/agent-guardrails.yml", ".github/CODEOWNERS"]) {
      const out = write(file);
      expect(out.code, file).toBe(0);
      expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, file).toBe("ask");
    }
    expect(run(command, root, bash("git config core.hooksPath /dev/null", root), env).code).toBe(2);
    expect(run(command, root, bash("git commit --no-verify -m x", root), env).code).toBe(2);
  });

  it("applies rule changes through applySync as well", async () => {
    const { root } = await installAll();
    const plan = await planSync(diskSyncIo(root), { agents: AGENT_IDS });
    expect(await applySync(root, plan)).toEqual([]);
  });
});
