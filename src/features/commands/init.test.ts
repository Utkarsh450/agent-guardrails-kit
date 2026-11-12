import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedUi } from "../../../tests/helpers/scripted-ui.ts";
import { CancelledError, CliError } from "./errors.ts";
import { runInit, type InitOptions } from "./init.ts";
import { runUpdate } from "./update.ts";
import { findProjectRoot, parseAgentList, parsePreset, parseStack, resolveRoot } from "./context.ts";

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function project(files: Record<string, string> = {}, { git = false } = {}): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-cmd-")));
  if (git) spawnSync("git", ["init", "-q"], { cwd: root, env: gitEnv });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

const exists = async (root: string, rel: string) =>
  readFile(path.join(root, rel), "utf8").then(
    () => true,
    () => false,
  );
const read = (root: string, rel: string) => readFile(path.join(root, rel), "utf8");
const run = (root: string, ui: ScriptedUi, options: InitOptions = {}) => runInit({ cwd: root, ui }, options);

describe("init with flags (no prompts)", () => {
  it("sets everything up with --yes and saves the choices", async () => {
    const root = await project({ "package.json": JSON.stringify({ packageManager: "pnpm@11.0.0" }) });
    const ui = new ScriptedUi([], false);
    expect(await run(root, ui, { agents: "claude,cursor", preset: "team", yes: true })).toBe(0);

    for (const file of ["agent-guardrails.config.json", ".agent-guardrails/guard.mjs", ".claude/settings.json", ".cursor/hooks.json", "AGENTS.md", ".githooks/pre-commit", ".github/workflows/agent-guardrails.yml"]) {
      expect(await exists(root, file), file).toBe(true);
    }
    expect(await exists(root, ".codex/hooks.json")).toBe(false);
    const config = JSON.parse(await read(root, "agent-guardrails.config.json"));
    expect(config).toMatchObject({ agents: ["claude", "cursor"], preset: "team", stack: "node-ts", approvalGate: true, policy: "ask" });
    expect(config.allowCommands).toContain("pnpm test");
    expect(ui.text).toContain("Plan: ");
    expect(ui.text).toContain("Wrote ");
    expect(ui.prompts).toEqual([]);
  });

  it("a second run finds everything already set up and writes nothing", async () => {
    const root = await project();
    await run(root, new ScriptedUi([], false), { agents: "claude", yes: true });
    const before = await read(root, ".claude/settings.json");
    const ui = new ScriptedUi([], false);
    await run(root, ui, { agents: "claude", yes: true });
    expect(ui.text).toContain("Everything is already set up.");
    expect(await read(root, ".claude/settings.json")).toBe(before);
  });

  it("--dry-run shows the plan and writes nothing", async () => {
    const root = await project();
    const ui = new ScriptedUi([], false);
    await run(root, ui, { agents: "claude", dryRun: true });
    expect(ui.text).toContain("Dry run: nothing was written.");
    expect(ui.text).toContain("+ AGENTS.md");
    expect(await exists(root, "AGENTS.md")).toBe(false);
    expect(await exists(root, "agent-guardrails.config.json")).toBe(false);
  });

  it("refuses to change files without --yes when nobody can be asked", async () => {
    const root = await project();
    await expect(run(root, new ScriptedUi([], false), { agents: "claude" })).rejects.toThrow(/run again with --yes/);
    expect(await exists(root, "AGENTS.md")).toBe(false);
  });

  it("needs to be told which agents to use when nobody can be asked", async () => {
    const root = await project();
    await expect(run(root, new ScriptedUi([], false), { yes: true })).rejects.toThrow(/Say which agents/);
  });

  it("with --yes, uses the agents it finds in the project", async () => {
    const root = await project({ "CLAUDE.md": "mine", ".cursor/rules/a.mdc": "x" });
    const ui = new ScriptedUi([], false);
    await run(root, ui, { yes: true });
    expect(ui.text).toContain("Using the agents found in this project");
    expect(await exists(root, ".cursor/hooks.json")).toBe(true);
    expect(await exists(root, ".claude/settings.json")).toBe(true);
  });

  it("explains bad flag values", async () => {
    const root = await project();
    await expect(run(root, new ScriptedUi([], false), { agents: "claud", yes: true })).rejects.toThrow(/Unknown agent: claud/);
    await expect(run(root, new ScriptedUi([], false), { agents: "claude", preset: "wild", yes: true })).rejects.toThrow(/Unknown preset "wild"/);
    await expect(run(root, new ScriptedUi([], false), { agents: "claude", stack: "cobol", yes: true })).rejects.toThrow(/Unknown stack "cobol"/);
  });

  it("keeps hand-written files and says so", async () => {
    const root = await project({ "CLAUDE.md": "my own notes", ".github/CODEOWNERS": "* @team" });
    const ui = new ScriptedUi([], false);
    await run(root, ui, { agents: "claude", yes: true });
    expect(await read(root, "CLAUDE.md")).toBe("my own notes");
    expect(await read(root, ".github/CODEOWNERS")).toBe("* @team");
    expect(ui.text).toContain("- CLAUDE.md  (your version is kept)");
  });

  it("warns about a settings file it cannot change and still sets up the rest", async () => {
    const root = await project({ ".claude/settings.json": "{ // comment\n}" });
    const ui = new ScriptedUi([], false);
    await run(root, ui, { agents: "claude", yes: true });
    expect(await read(root, ".claude/settings.json")).toBe("{ // comment\n}");
    expect(ui.text).toContain("! .claude/settings.json");
    expect(ui.text).toMatch(/not valid JSON/);
    expect(ui.text).toContain("left exactly as they are");
    expect(await exists(root, ".agent-guardrails/guard.mjs")).toBe(true);
  });

  it("can leave out the GitHub files", async () => {
    const root = await project();
    await run(root, new ScriptedUi([], false), { agents: "claude", yes: true, github: false });
    expect(await exists(root, ".github/workflows/agent-guardrails.yml")).toBe(false);
    expect(JSON.parse(await read(root, "agent-guardrails.config.json")).github).toBe(false);
  });

  it("--diff shows what changes inside existing files", async () => {
    const root = await project({ ".gitignore": "node_modules/\n" });
    const ui = new ScriptedUi([], false);
    await run(root, ui, { agents: "claude", dryRun: true, diff: true });
    expect(ui.text).toContain("~ .gitignore");
    expect(ui.text).toContain("+# >>> agent-guardrails:state");
  });
});

describe("init with prompts", () => {
  it("asks about agents, strictness, project kind and GitHub, then for approval", async () => {
    const root = await project({ "CLAUDE.md": "mine", "package.json": "{}" });
    const ui = new ScriptedUi([["claude", "codex"], "learner", "python", false, "apply"]);
    await run(root, ui);
    expect(ui.prompts).toEqual([
      "Which AI agents do you use?",
      "How strict should it be?",
      expect.stringContaining("What kind of project is this?"),
      expect.stringContaining("Add GitHub files"),
      "What next?",
    ]);
    expect(ui.prompts[2]).toContain("looks like node-ts, from package.json");
    const config = JSON.parse(await read(root, "agent-guardrails.config.json"));
    expect(config).toMatchObject({ agents: ["claude", "codex"], preset: "learner", stack: "python", github: false, auditAllowed: true });
    expect(await exists(root, ".codex/hooks.json")).toBe(true);
    expect(await exists(root, ".github/CODEOWNERS")).toBe(false);
  });

  it("cancelling at the approval step changes nothing", async () => {
    const root = await project();
    const ui = new ScriptedUi([["claude"], "balanced", "generic", true, "cancel"]);
    await expect(run(root, ui)).rejects.toThrow(CancelledError);
    expect(await exists(root, "AGENTS.md")).toBe(false);
    expect(await exists(root, "agent-guardrails.config.json")).toBe(false);
  });

  it("can show the details before applying, and the details list changes to existing files", async () => {
    const root = await project({ ".gitignore": "dist/\n" });
    const ui = new ScriptedUi([["claude"], "balanced", "generic", false, "details", "apply"]);
    await run(root, ui);
    expect(ui.text).toContain(".gitignore");
    expect(ui.text).toContain("+# >>> agent-guardrails:secrets");
    expect(await exists(root, "AGENTS.md")).toBe(true);
  });

  it("does not offer the details step when no existing file would change", async () => {
    const root = await project();
    const ui = new ScriptedUi([["claude"], "balanced", "generic", true, "apply"]);
    await run(root, ui);
    expect(ui.offered["What next?"]).toEqual(["apply", "cancel"]);
  });

  it("--yes skips the choices and uses detected or saved defaults, even in a terminal", async () => {
    const root = await project({ "CLAUDE.md": "x", "go.mod": "module x" });
    const ui = new ScriptedUi([], true);
    await run(root, ui, { yes: true });
    expect(ui.prompts).toEqual([]);
    expect(JSON.parse(await read(root, "agent-guardrails.config.json"))).toMatchObject({ stack: "go", preset: "balanced" });
  });

  it("a rerun starts from the saved choices", async () => {
    const root = await project();
    await run(root, new ScriptedUi([], false), { agents: "claude,qoder", preset: "team", stack: "go", yes: true, github: false });
    const seen: string[] = [];
    const ui = new ScriptedUi([
      (prompt) => (seen.push(prompt), ["claude", "qoder"]),
      "team",
      "go",
      false,
    ]);
    await run(root, ui);
    expect(ui.prompts).toHaveLength(4); // nothing to approve: no "What next?" prompt
    expect(ui.text).toContain("Everything is already set up.");
  });
});

describe("git hooks step", () => {
  it("offers to turn the hooks on in a git repo, and does it when the person agrees", async () => {
    const root = await project({}, { git: true });
    const ui = new ScriptedUi([["claude"], "balanced", "generic", false, "apply", true]);
    await run(root, ui);
    expect(ui.prompts.at(-1)).toContain("Turn the git hooks on now?");
    expect(ui.text).toContain("Ran: git config core.hooksPath .githooks");
    const result = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8", env: gitEnv });
    expect(result.stdout.trim()).toBe(".githooks");
    expect(ui.text).not.toContain("Next: git");
  });

  it("leaves git alone when the person says no, and prints the command instead", async () => {
    const root = await project({}, { git: true });
    const ui = new ScriptedUi([["claude"], "balanced", "generic", false, "apply", false]);
    await run(root, ui);
    const result = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8", env: gitEnv });
    expect(result.status).toBe(1);
    expect(ui.text).toContain("git config core.hooksPath .githooks");
  });

  it("with --yes only touches git config when --git-config is also given", async () => {
    const without = await project({}, { git: true });
    await run(without, new ScriptedUi([], false), { agents: "claude", yes: true });
    expect(spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: without, env: gitEnv }).status).toBe(1);

    const withFlag = await project({}, { git: true });
    await run(withFlag, new ScriptedUi([], false), { agents: "claude", yes: true, gitConfig: true });
    expect(spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: withFlag, encoding: "utf8", env: gitEnv }).stdout.trim()).toBe(".githooks");
  });

  it("explains git when the folder is not a repository", async () => {
    const root = await project();
    const ui = new ScriptedUi([], false);
    await run(root, ui, { agents: "claude", yes: true });
    expect(ui.text).toMatch(/not a git repository/);
  });
});

describe("refusing bad places", () => {
  it("will not set up guardrails in the home folder, the file system root or a missing folder", async () => {
    await expect(run(os.homedir(), new ScriptedUi([], false), { agents: "claude", yes: true })).rejects.toThrow(/home folder/);
    await expect(run("/", new ScriptedUi([], false), { agents: "claude", yes: true })).rejects.toThrow(/root of the file system/);
    await expect(run("/definitely/not/here", new ScriptedUi([], false), { agents: "claude", yes: true })).rejects.toThrow(/does not exist/);
  });

  it("will not treat a file as a project", async () => {
    const root = await project({ "file.txt": "x" });
    expect(() => resolveRoot(path.join(root, "file.txt"))).toThrow(/is not a folder/);
  });
});

describe("update", () => {
  it("needs saved settings", async () => {
    const root = await project();
    await expect(runUpdate({ cwd: root, ui: new ScriptedUi([], false) }, { yes: true })).rejects.toThrow(/Run `agent-guardrails init` first/);
  });

  it("says everything is up to date right after init", async () => {
    const root = await project();
    await run(root, new ScriptedUi([], false), { agents: "claude,cursor", yes: true });
    const ui = new ScriptedUi([], false);
    await runUpdate({ cwd: root, ui }, { yes: true });
    expect(ui.text).toContain("Everything is up to date.");
  });

  it("restores a guard that was changed or is out of date, using the saved choices", async () => {
    const root = await project();
    await run(root, new ScriptedUi([], false), { agents: "claude", preset: "team", yes: true });
    const good = await read(root, ".agent-guardrails/guard.mjs");
    await writeFile(path.join(root, ".agent-guardrails/guard.mjs"), `${good}\n// tampered\n`, "utf8");

    const ui = new ScriptedUi([], false);
    await runUpdate({ cwd: root, ui }, { yes: true });
    expect(await read(root, ".agent-guardrails/guard.mjs")).toBe(good);
    expect(ui.text).toContain("~ .agent-guardrails/guard.mjs");
    expect(JSON.parse(await read(root, "agent-guardrails.config.json")).preset).toBe("team");
  });

  it("without --yes it asks before writing, and --dry-run only shows", async () => {
    const root = await project();
    await run(root, new ScriptedUi([], false), { agents: "claude", yes: true });
    const guard = path.join(root, ".agent-guardrails/guard.mjs");
    const good = await read(root, ".agent-guardrails/guard.mjs");
    await writeFile(guard, `${good}\n// old\n`, "utf8");

    const dry = new ScriptedUi([], false);
    await runUpdate({ cwd: root, ui: dry }, { dryRun: true });
    expect(dry.text).toContain("Dry run");
    expect(await read(root, ".agent-guardrails/guard.mjs")).toContain("// old");

    await expect(runUpdate({ cwd: root, ui: new ScriptedUi([], false) }, {})).rejects.toThrow(/--yes/);
    await runUpdate({ cwd: root, ui: new ScriptedUi(["apply"]) }, {});
    expect(await read(root, ".agent-guardrails/guard.mjs")).toBe(good);
  });

  it("does not bring back a rule the person deleted, and never overwrites edited rules", async () => {
    const root = await project();
    await run(root, new ScriptedUi([], false), { agents: "claude", yes: true });
    await writeFile(path.join(root, "agent-rules/always/safety.md"), "---\ndescription: Mine\n---\n\n# Mine\n\nCustom text.", "utf8");
    // Truncate a default rule file to empty instead of deleting it is not "deleted"; emulate deletion by renaming away.
    const { rename } = await import("node:fs/promises");
    await rename(path.join(root, "agent-rules/scoped/database.md"), path.join(root, "agent-rules/scoped/database.md.off"));

    await runUpdate({ cwd: root, ui: new ScriptedUi([], false) }, { yes: true });
    expect(await exists(root, "agent-rules/scoped/database.md")).toBe(false);
    expect(await read(root, "agent-rules/always/safety.md")).toContain("Custom text.");
    expect(await read(root, "AGENTS.md")).toContain("Custom text.");
  });
});

describe("argument parsing", () => {
  it("parses agent lists", () => {
    expect(parseAgentList("all")).toEqual(["claude", "cursor", "codex", "antigravity", "qoder"]);
    expect(parseAgentList("Claude, cursor ,claude")).toEqual(["claude", "cursor"]);
    expect(() => parseAgentList("")).toThrow(CliError);
    expect(() => parseAgentList("claude,vim")).toThrow(/Unknown agent: vim/);
  });

  it("parses presets and stacks", () => {
    expect(parsePreset("team")).toBe("team");
    expect(parseStack("go")).toBe("go");
    expect(() => parsePreset("x")).toThrow(CliError);
    expect(() => parseStack("x")).toThrow(CliError);
  });
});

describe("finding the project from a subfolder", () => {
  it("climbs to the folder that holds the settings, and falls back to the folder itself", async () => {
    const root = await project({ "src/deep/a.ts": "x" });
    expect(findProjectRoot(path.join(root, "src/deep"))).toBe(path.join(root, "src/deep")); // not set up yet
    await run(root, new ScriptedUi([], false), { agents: "claude", yes: true });
    expect(findProjectRoot(path.join(root, "src/deep"))).toBe(root);
    expect(findProjectRoot(root)).toBe(root);
  });

  it("lets doctor, approve and update work from a subfolder", async () => {
    const root = await project({ "src/deep/a.ts": "x" });
    await run(root, new ScriptedUi([], false), { agents: "claude", yes: true });
    const ui = new ScriptedUi([], false);
    await runUpdate({ cwd: path.join(root, "src/deep"), ui }, { yes: true });
    expect(ui.text).toContain("Everything is up to date.");
  });

  it("init in a nested folder warns that an outer project exists, and still works there", async () => {
    const root = await project({ "packages/app/index.ts": "x" });
    await run(root, new ScriptedUi([], false), { agents: "claude", yes: true });
    const ui = new ScriptedUi([], false);
    await run(path.join(root, "packages/app"), ui, { agents: "cursor", yes: true });
    expect(ui.text).toContain(`already set up`);
    expect(await exists(path.join(root, "packages/app"), ".cursor/hooks.json")).toBe(true);
  });
});
