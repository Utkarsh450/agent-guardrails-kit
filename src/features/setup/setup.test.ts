import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../shared/agents.ts";
import { memoryIo, type MemoryIo } from "../../../tests/helpers/memory-io.ts";
import { diskSyncIo } from "../rules/index.ts";
import { applySetup, bucketOf, buildSetupPlan, countBuckets, loadSavedConfig, readHooksPath, renderDiff, renderPreview, setHooksPath } from "./index.ts";
import type { SetupOptions, SetupPlan } from "./types.ts";

const options = (extra: Partial<SetupOptions> = {}): SetupOptions => ({
  agents: [...AGENT_IDS],
  preset: "balanced",
  stack: "node-ts",
  packageManager: "pnpm",
  github: true,
  ...extra,
});

const plan = (io: MemoryIo, extra: Partial<SetupOptions> = {}, hooksPathSet: boolean | null = false) =>
  buildSetupPlan({ options: options(extra), io, hooksPathSet });

/** Writes the plan's creates and updates into the in-memory project, as init would. */
function apply(io: MemoryIo, result: SetupPlan): void {
  for (const { file } of result.entries) if (file.status === "create" || file.status === "update") io.files.set(file.path, file.content);
}

const entry = (result: SetupPlan, rel: string) => result.entries.find((e) => e.file.path === rel);
const json = (result: SetupPlan, rel: string) => JSON.parse(entry(result, rel)?.file.content ?? "null") as Record<string, any>;

describe("buildSetupPlan: a fresh project", () => {
  it("plans every group and creates every file", async () => {
    const result = await plan(memoryIo());
    const groups = new Set(result.entries.map((e) => e.group));
    expect([...groups].sort()).toEqual(["agents", "config", "git", "github", "guard", "rules"]);
    expect(result.entries.every((e) => e.file.status === "create")).toBe(true);
    expect(countBuckets(result)).toMatchObject({ create: result.entries.length, update: 0, kept: 0, conflict: 0 });
    const paths = result.entries.map((e) => e.file.path);
    for (const expected of [
      "agent-rules/always/safety.md", "agent-guardrails.config.json", ".agent-guardrails/guard.mjs", "AGENTS.md", "CLAUDE.md", "GEMINI.md",
      ".claude/settings.json", ".cursor/hooks.json", ".codex/hooks.json", ".qoder/settings.json", ".githooks/pre-commit", ".gitignore",
      ".github/workflows/agent-guardrails.yml", ".cursor/rules/database.mdc",
    ]) expect(paths, expected).toContain(expected);
  });

  it("plans the generated files against the rules it is about to create", async () => {
    const result = await plan(memoryIo());
    const agentsMd = entry(result, "AGENTS.md")?.file.content ?? "";
    expect(agentsMd).toContain("Hard limits");
    expect(agentsMd).toContain("Plan, then approval");
    expect(agentsMd).toContain("| `agent-rules/scoped/database.md` |");
  });

  it("writes a settings file with the guard's settings and the chosen CLI settings", async () => {
    const result = await plan(memoryIo(), { preset: "team", agents: ["claude", "codex"] });
    const config = json(result, "agent-guardrails.config.json");
    expect(config).toMatchObject({
      version: 1, policy: "ask", approvalGate: true, planFile: "PLAN.md", auditAllowed: false,
      agents: ["claude", "codex"], preset: "team", stack: "node-ts", alwaysRuleFiles: false, github: true,
    });
    expect(config.allowCommands).toEqual(expect.arrayContaining(["pnpm test", "pnpm build"]));
    expect(config.gitAllow).toContain("ls-files");
    expect(Object.keys(config).slice(0, 7)).toEqual(["version", "policy", "allowCommands", "gitAllow", "approvalGate", "planFile", "auditAllowed"]);
  });

  it("lists the enforcement level of each agent", async () => {
    const result = await plan(memoryIo());
    expect(Object.fromEntries(result.enforcement.map((e) => [e.agent, e.enforcement]))).toEqual({
      claude: "enforced", cursor: "enforced", codex: "enforced", antigravity: "advisory", qoder: "enforced",
    });
  });

  it("only touches the agents asked for", async () => {
    const result = await plan(memoryIo(), { agents: ["claude"] });
    const paths = result.entries.map((e) => e.file.path);
    expect(paths).toContain(".claude/settings.json");
    expect(paths).toContain("CLAUDE.md");
    expect(paths).not.toContain(".cursor/hooks.json");
    expect(paths).not.toContain("GEMINI.md");
    expect(paths).not.toContain(".codex/hooks.json");
  });

  it("can leave out the GitHub files and can add a doctor step to CI", async () => {
    const without = await plan(memoryIo(), { github: false });
    expect(without.entries.some((e) => e.group === "github")).toBe(false);
    expect(json(without, "agent-guardrails.config.json").github).toBe(false);
    const withDoctor = await plan(memoryIo(), { doctorPackage: { packageName: "agent-guardrails-kit", version: "1.0.0" } });
    expect(entry(withDoctor, ".github/workflows/agent-guardrails.yml")?.file.content).toContain("npx --yes agent-guardrails-kit@1.0.0 doctor --ci");
  });

  it("learner repeats always-on rules in each agent's folder", async () => {
    const result = await plan(memoryIo(), { preset: "learner" });
    const paths = result.entries.map((e) => e.file.path);
    expect(json(result, "agent-guardrails.config.json")).toMatchObject({ auditAllowed: true, alwaysRuleFiles: true });
    expect(paths).toContain(".cursor/rules/safety.mdc");
    expect(paths).toContain(".qoder/rules/approval.md");
  });
});

describe("buildSetupPlan: running it again", () => {
  it("changes nothing once everything is in place", async () => {
    const io = memoryIo();
    apply(io, await plan(io));
    const again = await plan(io);
    expect(again.entries.filter((e) => e.file.status !== "unchanged")).toEqual([]);
    expect(countBuckets(again).unchanged).toBe(again.entries.length);
  });

  it("keeps the person's rule edits and uses them when generating AGENTS.md", async () => {
    const io = memoryIo();
    apply(io, await plan(io));
    io.files.set("agent-rules/always/safety.md", "---\ndescription: Mine\n---\n\n# Mine\n\nCustom safety text.");
    const again = await plan(io);
    expect(bucketOf(entry(again, "agent-rules/always/safety.md")!)).toBe("kept");
    const agentsMd = entry(again, "AGENTS.md")!;
    expect(agentsMd.file.status).toBe("update");
    expect(agentsMd.file.content).toContain("Custom safety text.");
  });

  it("keeps existing guard settings, updates the CLI ones, and preserves extra keys", async () => {
    const io = memoryIo({
      "agent-guardrails.config.json": JSON.stringify({ policy: "allowlist", allowCommands: ["make test"], gitAllow: ["status"], note: "mine", preset: "learner" }, null, 2),
    });
    const config = json(await plan(io, { preset: "team" }), "agent-guardrails.config.json");
    expect(config).toMatchObject({ policy: "allowlist", allowCommands: ["make test"], gitAllow: ["status"], note: "mine", preset: "team", approvalGate: true });
  });

  it("does not touch settings that are invalid, and says why", async () => {
    const io = memoryIo({ "agent-guardrails.config.json": JSON.stringify({ policy: "yolo" }) });
    const result = await plan(io);
    const config = entry(result, "agent-guardrails.config.json")!;
    expect(config.file.status).toBe("conflict");
    expect(bucketOf(config)).toBe("conflict");
    expect(config.file.reason).toMatch(/existing settings are invalid/);
  });

  it("separates files the person owns (kept) from files that are damaged (conflict)", async () => {
    const io = memoryIo({ "CLAUDE.md": "my notes", ".claude/settings.json": "{ // oops\n}" });
    const result = await plan(io);
    expect(bucketOf(entry(result, "CLAUDE.md")!)).toBe("kept");
    expect(bucketOf(entry(result, ".claude/settings.json")!)).toBe("conflict");
    expect(countBuckets(result)).toMatchObject({ kept: 1, conflict: 1 });
  });

  it("init restores a default rule that is missing; update does not bring back one the person removed", async () => {
    const io = memoryIo();
    apply(io, await plan(io));
    io.files.delete("agent-rules/scoped/database.md");

    const init = await plan(io);
    expect(entry(init, "agent-rules/scoped/database.md")?.file.status).toBe("create");

    const update = await buildSetupPlan({ options: options(), io, hooksPathSet: true, createMissingRules: false });
    expect(entry(update, "agent-rules/scoped/database.md")).toBeUndefined();
    expect(entry(update, "AGENTS.md")?.file.status).toBe("update"); // the scoped-rule index shrinks
  });

  it("reports generated files whose rule was removed", async () => {
    const io = memoryIo();
    apply(io, await plan(io));
    io.files.delete("agent-rules/scoped/database.md");
    const update = await buildSetupPlan({ options: options(), io, hooksPathSet: true, createMissingRules: false });
    expect(update.stale).toEqual(expect.arrayContaining([".cursor/rules/database.mdc", ".qoder/rules/database.md"]));
  });
});

describe("buildSetupPlan: git notes", () => {
  const gitNote = (r: SetupPlan) => r.notes.find((n) => n.title === "git");

  it("explains how to turn the hooks on when it is a repo and the setting is missing", async () => {
    const result = await plan(memoryIo({ ".git/HEAD": "ref" }), {}, false);
    expect(result.git).toEqual({ isRepo: true, hooksPathSet: false, command: "git config core.hooksPath .githooks" });
    expect(gitNote(result)?.lines.join("\n")).toContain("git config core.hooksPath .githooks");
  });

  it("says nothing when the setting is already in place", async () => {
    expect(gitNote(await plan(memoryIo({ ".git/HEAD": "ref" }), {}, true))).toBeUndefined();
  });

  it("says the folder is not a repository yet", async () => {
    const result = await plan(memoryIo(), {}, null);
    expect(result.git.isRepo).toBe(false);
    expect(gitNote(result)?.lines.join("\n")).toMatch(/not a git repository/);
  });

  it("carries the per-agent steps (Codex trust, Antigravity snippet) and the GitHub reminder", async () => {
    const result = await plan(memoryIo());
    expect(result.notes.find((n) => n.title === "codex")?.lines.join("\n")).toMatch(/\/hooks/);
    expect(result.notes.find((n) => n.title === "antigravity")?.lines.join("\n")).toContain("antigravity-cli/settings.json");
    expect(result.notes.find((n) => n.title === "github")?.lines.join("\n")).toMatch(/branch/i);
  });
});

describe("loadSavedConfig", () => {
  it("returns the saved settings, or null when missing or broken", async () => {
    expect(await loadSavedConfig(memoryIo())).toBeNull();
    expect(await loadSavedConfig(memoryIo({ "agent-guardrails.config.json": "{ nope" }))).toBeNull();
    expect(await loadSavedConfig(memoryIo({ "agent-guardrails.config.json": JSON.stringify({ policy: "yolo" }) }))).toBeNull();
    const saved = await loadSavedConfig(memoryIo({ "agent-guardrails.config.json": JSON.stringify({ agents: ["claude"], preset: "team" }) }));
    expect(saved).toMatchObject({ agents: ["claude"], preset: "team", policy: "ask" });
  });
});

describe("diff and preview rendering", () => {
  it("shows what changes in a file", async () => {
    const io = memoryIo({ ".gitignore": "node_modules/\n" });
    const result = await plan(io);
    const diff = renderDiff(entry(result, ".gitignore")!);
    expect(diff).toContain("+# >>> agent-guardrails:state");
    expect(diff).toContain(" node_modules/");
    expect(renderPreview(entry(result, "AGENTS.md")!, 3)).toMatch(/more lines$/);
  });

  it("trims very long diffs", async () => {
    const result = await plan(memoryIo());
    expect(renderDiff(entry(result, ".agent-guardrails/guard.mjs")!)).toMatch(/\.\.\. \d+ more lines$/);
  });
});

describe("applying to a real folder", () => {
  it("writes the plan, never the conflicts, and a second plan finds nothing to do", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-setup-")));
    await writeFile(path.join(root, "CLAUDE.md"), "my notes", "utf8");
    const io = diskSyncIo(root);
    const first = await buildSetupPlan({ options: options({ agents: ["claude", "cursor"] }), io, hooksPathSet: null });
    const written = await applySetup(root, first);
    expect(written).toContain(".agent-guardrails/guard.mjs");
    expect(written).not.toContain("CLAUDE.md");
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe("my notes");

    const second = await buildSetupPlan({ options: options({ agents: ["claude", "cursor"] }), io, hooksPathSet: null });
    expect(second.entries.filter((e) => bucketOf(e) !== "unchanged" && bucketOf(e) !== "kept")).toEqual([]);
  });

  it("sets and reads core.hooksPath in a throwaway git repo", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-hp-")));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    spawnSync("git", ["init", "-q"], { cwd: root, env });
    expect(readHooksPath(root)).toBe(false);
    expect(setHooksPath(root)).toEqual({ ok: true, message: "git config core.hooksPath .githooks" });
    expect(readHooksPath(root)).toBe(true);
    spawnSync("git", ["config", "core.hooksPath", "elsewhere"], { cwd: root, env });
    expect(readHooksPath(root)).toBe(false);
  });

  it("cannot tell outside a repository, and refuses to set it there", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-norepo-")));
    expect(setHooksPath(root).ok).toBe(false);
  });
});
