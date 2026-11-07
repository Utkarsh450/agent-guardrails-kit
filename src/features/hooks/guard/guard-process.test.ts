import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import guardSource from "./guard.mjs?raw";
import { createApprovalRecord, serializeApproval } from "../approval.ts";
import { interpretProcess, isStateless, runCorpusSpawned, summarize, formatFailures, allCases } from "../selftest.ts";

/**
 * These tests install the guard the way the kit will (a copy at <project>/.agent-guardrails/guard.mjs),
 * then run it as a separate process, exactly as Claude Code, Cursor and Codex do.
 * Temp folders are left for the OS to clean up: the kit's own rules forbid deleting files.
 */

async function installGuard(): Promise<{ root: string; guard: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-proc-"));
  const dir = path.join(root, ".agent-guardrails");
  await mkdir(dir, { recursive: true });
  const guard = path.join(dir, "guard.mjs");
  await writeFile(guard, guardSource, "utf8");
  return { root: await realpath(root), guard };
}

function run(guard: string, agent: string, payload: unknown, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [guard, "--agent", agent], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the installed guard, run as a process", () => {
  it("denies with exit code 2 and a message on stderr (Claude Code and Codex)", async () => {
    const { root, guard } = await installGuard();
    for (const agent of ["claude", "codex"]) {
      const out = run(guard, agent, { tool_name: "Bash", tool_input: { command: "rm -rf x" }, cwd: root });
      expect(out.code, agent).toBe(2);
      expect(out.stderr).toContain("file-deletion");
      expect(out.stdout).toBe("");
    }
  });

  it("allows with exit 0 and no output (Claude Code, Codex)", async () => {
    const { root, guard } = await installGuard();
    for (const agent of ["claude", "codex"]) {
      const out = run(guard, agent, { tool_name: "Bash", tool_input: { command: "git status" }, cwd: root });
      expect(out).toEqual({ code: 0, stdout: "", stderr: "" });
    }
  });

  it("asks through JSON for Claude Code and denies for Codex, which cannot ask", async () => {
    const { root, guard } = await installGuard();
    const payload = { tool_name: "Bash", tool_input: { command: "python script.py" }, cwd: root };
    const claude = run(guard, "claude", payload);
    expect(claude.code).toBe(0);
    expect(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    const codex = run(guard, "codex", payload);
    expect(codex.code).toBe(2);
    expect(codex.stderr).toMatch(/Codex cannot prompt/);
  });

  it("speaks Cursor's JSON format", async () => {
    const { root, guard } = await installGuard();
    const allow = run(guard, "cursor", { command: "ls", cwd: root, hook_event_name: "beforeShellExecution" });
    expect(allow.code).toBe(0);
    expect(JSON.parse(allow.stdout)).toEqual({ permission: "allow" });

    const ask = run(guard, "cursor", { command: "python x.py", cwd: root, hook_event_name: "beforeShellExecution" });
    expect(ask.code).toBe(0);
    expect(JSON.parse(ask.stdout).permission).toBe("ask");

    const deny = run(guard, "cursor", { command: "git push", cwd: root, hook_event_name: "beforeShellExecution" });
    expect(deny.code).toBe(2);
    expect(JSON.parse(deny.stdout)).toMatchObject({ permission: "deny" });
  });

  it("fails closed on empty input, bad JSON and a broken config", async () => {
    const { root, guard } = await installGuard();
    expect(run(guard, "claude", "").code).toBe(2);
    expect(run(guard, "claude", "{oops").code).toBe(2);
    expect(run(guard, "cursor", "").code).toBe(2);

    await writeFile(path.join(root, "agent-guardrails.config.json"), "{ nope", "utf8");
    const out = run(guard, "claude", { tool_name: "Bash", tool_input: { command: "ls" }, cwd: root });
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/bad-config/);
  });

  it("treats the folder it is installed in as the project, whatever cwd says", async () => {
    const { guard } = await installGuard();
    const out = run(guard, "claude", { tool_name: "Bash", tool_input: { command: "cat /etc/hosts" }, cwd: "/etc" });
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/outside-project/);
  });

  it("applies the approval gate with a real approval record", async () => {
    const { root, guard } = await installGuard();
    const write = { tool_name: "Write", tool_input: { file_path: path.join(root, "src", "a.ts"), content: "x" }, cwd: root };
    expect(run(guard, "claude", write).code).toBe(2);

    const plan = "# Plan\n- build it\n";
    await writeFile(path.join(root, "PLAN.md"), plan, "utf8");
    await writeFile(path.join(root, ".agent-guardrails", "approval.json"), serializeApproval(createApprovalRecord("PLAN.md", plan)), "utf8");
    expect(run(guard, "claude", write)).toEqual({ code: 0, stdout: "", stderr: "" });

    await writeFile(path.join(root, "PLAN.md"), `${plan}- sneaky\n`, "utf8");
    expect(run(guard, "claude", write).code).toBe(2);
  });

  it("honours allowCommands from the config file", async () => {
    const { root, guard } = await installGuard();
    await writeFile(path.join(root, "agent-guardrails.config.json"), JSON.stringify({ allowCommands: ["pnpm test"] }), "utf8");
    const out = run(guard, "claude", { tool_name: "Bash", tool_input: { command: "pnpm test" }, cwd: root });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("writes the audit log, unless told not to", async () => {
    const { root, guard } = await installGuard();
    const payload = { tool_name: "Bash", tool_input: { command: "git push" }, cwd: root };
    run(guard, "claude", payload, { AGENT_GUARDRAILS_NO_AUDIT: "1" });
    await expect(readFile(path.join(root, ".agent-guardrails", "audit.log"), "utf8")).rejects.toThrow();

    run(guard, "claude", payload);
    const log = await readFile(path.join(root, ".agent-guardrails", "audit.log"), "utf8");
    expect(JSON.parse(log.trim())).toMatchObject({ agent: "claude", decision: "deny", rule: "git-write", detail: "git push" });
  });

  it("still runs (and blocks) when it is reached through a symlink", async () => {
    // Regression: the entry-point check once compared unresolved paths, so through a symlink the guard
    // did nothing at all and exited 0, which allowed every action.
    const { root } = await installGuard();
    const holder = await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-link-"));
    const linkedRoot = path.join(holder, "linked-project");
    await symlink(root, linkedRoot);
    const viaLink = path.join(linkedRoot, ".agent-guardrails", "guard.mjs");
    const out = run(viaLink, "claude", { tool_name: "Bash", tool_input: { command: "rm -rf x" }, cwd: root });
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("file-deletion");

    // And through a symlink to the guard file itself.
    const fileLink = path.join(holder, "guard-link.mjs");
    await symlink(path.join(root, ".agent-guardrails", "guard.mjs"), fileLink);
    expect(run(fileLink, "claude", { tool_name: "Bash", tool_input: { command: "rm -rf x" }, cwd: root }).code).toBe(2);
  });

  it("starts quickly enough to run before every tool call", async () => {
    const { root, guard } = await installGuard();
    const started = Date.now();
    for (let k = 0; k < 5; k += 1) run(guard, "claude", { tool_name: "Bash", tool_input: { command: "ls" }, cwd: root });
    expect((Date.now() - started) / 5).toBeLessThan(500);
  });
});

// One process per case is slow (about 0.1 s each). By default a spread sample runs; FULL_CORPUS=1 runs everything.
const every = process.env.FULL_CORPUS === "1" ? 1 : 7;

describe("corpus against the installed guard", () => {
  it("passes the stateless cases for Claude Code", async () => {
    const { root, guard } = await installGuard();
    const stateless = allCases.filter(isStateless);
    expect(stateless.length).toBeGreaterThan(400);
    const cases = stateless.filter((_, index) => index % every === 0);
    const summary = summarize(runCorpusSpawned({ guardPath: guard, root, agent: "claude", cases }));
    expect(summary.failed.length, formatFailures(summary)).toBe(0);
  }, 300_000);

  it("passes the dangerous cases for Cursor and Codex too", async () => {
    const { root, guard } = await installGuard();
    const cases = allCases.filter((c) => isStateless(c) && (c.expect === "deny" || c.expect === "allow")).filter((_, index) => index % (every * 3) === 0);
    for (const agent of ["cursor", "codex"] as const) {
      const summary = summarize(runCorpusSpawned({ guardPath: guard, root, agent, cases }));
      expect(summary.failed.length, `${agent}\n${formatFailures(summary)}`).toBe(0);
    }
  }, 120_000);
});

describe("interpretProcess", () => {
  it("reads each agent's answer", () => {
    expect(interpretProcess("claude", 2, "", "agent-guardrails blocked this (git-write): x").rule).toBe("git-write");
    expect(interpretProcess("claude", 0, "", "")).toMatchObject({ decision: "allow" });
    expect(interpretProcess("cursor", 0, '{"permission":"allow"}', "").decision).toBe("allow");
    expect(interpretProcess("cursor", 0, '{"permission":"ask"}', "").decision).toBe("ask");
    expect(interpretProcess("cursor", 2, '{"permission":"deny"}', "").decision).toBe("deny");
    expect(interpretProcess("claude", 1, "", "boom").decision).toBe("deny");
    expect(interpretProcess("claude", 0, "garbage", "").decision).toBe("deny");
  });
});
