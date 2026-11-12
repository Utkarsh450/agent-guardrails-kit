import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../shared/agents.ts";
import { GENERATED_MARKER } from "../../shared/fs-plan.ts";
import { memoryIo } from "../../../tests/helpers/memory-io.ts";
import { applySync, desiredFiles, diskSyncIo, planSync } from "./sync.ts";
import { defaultRuleSources } from "./templates/index.ts";

function seededIo(extra: Record<string, string> = {}, symlinks: string[] = []) {
  const files: Record<string, string> = { ...extra };
  for (const source of defaultRuleSources) files[`agent-rules/${source.path}`] = source.content;
  return memoryIo(files, symlinks);
}

describe("planSync (in memory)", () => {
  it("plans every agent's files on first run", async () => {
    const plan = await planSync(seededIo(), { agents: AGENT_IDS });
    const paths = plan.files.map((file) => file.path);

    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain("GEMINI.md");
    expect(paths).toContain(".cursor/rules/database.mdc");
    expect(paths).toContain(".agents/rules/database.md");
    expect(paths).toContain(".qoder/rules/database.md");
    expect(plan.files.every((file) => file.status === "create")).toBe(true);
    expect(plan.stale).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("does not repeat always-on rules in per-agent folders (they read AGENTS.md)", async () => {
    const plan = await planSync(seededIo(), { agents: AGENT_IDS });
    const paths = plan.files.map((file) => file.path);
    expect(paths).not.toContain(".cursor/rules/safety.mdc");
    expect(paths).not.toContain(".agents/rules/safety.md");
    expect(paths).not.toContain(".qoder/rules/safety.md");
  });

  it("can write always-on rule files too when asked", async () => {
    const plan = await planSync(seededIo(), { agents: AGENT_IDS, alwaysRuleFiles: true });
    const paths = plan.files.map((file) => file.path);
    expect(paths).toContain(".cursor/rules/safety.mdc");
    expect(paths).toContain(".agents/rules/safety.md");
    expect(paths).toContain(".qoder/rules/safety.md");
  });

  it("warns when AGENTS.md is too big for Antigravity", async () => {
    const big = `---\ndescription: Big\n---\n\n${"Rule text that goes on and on. ".repeat(1000)}`;
    const io = seededIo({ "agent-rules/always/zz-big.md": big });
    const forAntigravity = await planSync(io, { agents: ["antigravity"] });
    expect(forAntigravity.warnings.join(" ")).toMatch(/Antigravity truncates/);
    const forClaude = await planSync(io, { agents: ["claude"] });
    expect(forClaude.warnings).toEqual([]);
  });

  it("writes only AGENTS.md for Codex", async () => {
    const plan = await planSync(seededIo(), { agents: ["codex"] });
    expect(plan.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const io = seededIo();
    const first = await planSync(io, { agents: AGENT_IDS });
    for (const file of first.files) io.files.set(file.path, file.content);

    const second = await planSync(io, { agents: AGENT_IDS });
    expect(second.files.every((file) => file.status === "unchanged")).toBe(true);
  });

  it("updates generated files when a rule changes", async () => {
    const io = seededIo();
    const first = await planSync(io, { agents: ["claude"] });
    for (const file of first.files) io.files.set(file.path, file.content);

    io.files.set(
      "agent-rules/always/repo.md",
      "---\ndescription: Changed\n---\n\n# Changed\n\nNew text.",
    );
    const second = await planSync(io, { agents: ["claude"] });
    const agentsMd = second.files.find((file) => file.path === "AGENTS.md");
    expect(agentsMd?.status).toBe("update");
    expect(agentsMd?.content).toContain("New text.");
  });

  it("never overwrites a hand-written CLAUDE.md", async () => {
    const plan = await planSync(seededIo({ "CLAUDE.md": "my own notes" }), { agents: ["claude"] });
    const claude = plan.files.find((file) => file.path === "CLAUDE.md");
    expect(claude?.status).toBe("conflict");
  });

  it("never writes through a symlink", async () => {
    const plan = await planSync(seededIo({}, ["GEMINI.md"]), { agents: ["antigravity"] });
    const gemini = plan.files.find((file) => file.path === "GEMINI.md");
    expect(gemini?.status).toBe("conflict");
  });

  it("reports stale generated files without touching them", async () => {
    const io = seededIo({
      ".cursor/rules/old.mdc": `---\n---\n<!-- ${GENERATED_MARKER} -->\nold`,
      ".cursor/rules/mine.mdc": "---\n---\nhand written",
    });
    const plan = await planSync(io, { agents: ["cursor"] });
    expect(plan.stale).toEqual([".cursor/rules/old.mdc"]);
  });

  it("fails clearly when there are no always rules", async () => {
    await expect(planSync(memoryIo(), { agents: ["codex"] })).rejects.toThrow(/agent-guardrails-kit init/);
  });

  it("rejects a rule name used in both scopes", async () => {
    const io = seededIo({
      "agent-rules/scoped/safety.md":
        '---\ndescription: dup\nglobs:\n  - "**/*"\n---\nBody',
    });
    await expect(planSync(io, { agents: ["codex"] })).rejects.toThrow(/used twice/);
  });

  it("honours a custom rules directory", async () => {
    const io = memoryIo({
      "docs/rules/always/a.md": "---\ndescription: A\n---\nBody A",
    });
    const plan = await planSync(io, { agents: ["codex"], rulesDir: "docs/rules" });
    expect(plan.files[0]?.content).toContain("Body A");
    expect(plan.files[0]?.content).toContain("docs/rules/always/");
  });
});

describe("desiredFiles", () => {
  it("is pure and deterministic", async () => {
    const plan = await planSync(seededIo(), { agents: AGENT_IDS });
    const again = desiredFiles(plan.rules, AGENT_IDS, "agent-rules");
    expect(again.map((file) => file.path)).toEqual(plan.files.map((file) => file.path));
  });
});

describe("applySync (real disk)", () => {
  // Temp folders live under the OS temp dir. The tests never delete anything, in line with the kit's own rules.
  async function tempProject(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-test-"));
    for (const source of defaultRuleSources) {
      const abs = path.join(root, "agent-rules", ...source.path.split("/"));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, source.content, "utf8");
    }
    return root;
  }

  it("writes generated files and leaves conflicts untouched", async () => {
    const root = await tempProject();
    await writeFile(path.join(root, "CLAUDE.md"), "hand written", "utf8");

    const plan = await planSync(diskSyncIo(root), { agents: AGENT_IDS });
    const written = await applySync(root, plan);

    expect(written).toContain("AGENTS.md");
    expect(written).not.toContain("CLAUDE.md");
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe("hand written");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain("Never run");
    expect(await readFile(path.join(root, ".cursor/rules/database.mdc"), "utf8")).toContain(
      "alwaysApply: false",
    );

    const second = await planSync(diskSyncIo(root), { agents: AGENT_IDS });
    expect(second.files.filter((file) => file.status === "create" || file.status === "update")).toEqual([]);
  });

  it("does not write through a symlink", async () => {
    const root = await tempProject();
    await writeFile(path.join(root, "target.txt"), "keep me", "utf8");
    await symlink(path.join(root, "target.txt"), path.join(root, "GEMINI.md"));

    const plan = await planSync(diskSyncIo(root), { agents: ["antigravity"] });
    await applySync(root, plan);

    expect((await lstat(path.join(root, "GEMINI.md"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(root, "target.txt"), "utf8")).toBe("keep me");
  });

  it("refuses to write through a symlinked folder that leaves the project", async () => {
    const root = await tempProject();
    const outside = await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-outside-"));
    await symlink(outside, path.join(root, ".cursor"));

    const plan = await planSync(diskSyncIo(root), { agents: ["cursor"] });
    await expect(applySync(root, plan)).rejects.toThrow(/outside the project/);
  });
});
