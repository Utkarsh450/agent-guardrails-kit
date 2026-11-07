import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { put, tempProject } from "../../../tests/helpers/checkpoint-store.ts";
import { ScriptedUi } from "../../../tests/helpers/scripted-ui.ts";
import { PRESET_KIND, parsePresetFile, presetHash } from "../team-presets/index.ts";
import { CancelledError, CliError } from "./errors.ts";
import { runInit } from "./init.ts";
import { runPreset } from "./preset.ts";
import { runUpdate } from "./update.ts";

const CONFIG = "agent-guardrails.config.json";
const preset = (settings: object, name = "acme") => `${JSON.stringify({ kind: PRESET_KIND, version: 1, name, settings }, null, 2)}\n`;
const config = async (root: string) => JSON.parse(await readFile(path.join(root, CONFIG), "utf8")) as Record<string, any>;
const quiet = () => new ScriptedUi([], false);
const use = (root: string, target: string | undefined, ui = quiet(), extra: object = {}) => runPreset({ cwd: root, ui }, "use", { target, yes: true, ...extra });
const exportTo = (root: string, target: string | undefined, ui = quiet(), extra: object = {}) => runPreset({ cwd: root, ui }, "export", { target, yes: true, ...extra });
const simple = (extra: object = {}) => tempProject({ [CONFIG]: JSON.stringify({ version: 1, ...extra }) });

describe("preset export", () => {
  it("writes this project's settings as a preset file", async () => {
    const root = await simple({ policy: "allowlist", allowCommands: ["pnpm test"], auditAllowed: true });
    const ui = quiet();
    expect(await exportTo(root, "team.json", ui, { description: "Acme defaults" })).toBe(0);
    const written = parsePresetFile(await readFile(path.join(root, "team.json"), "utf8"));
    expect(written.name).toBe(path.basename(root));
    expect(written.description).toBe("Acme defaults");
    expect(written.settings).toMatchObject({ policy: "allowlist", allowCommands: ["pnpm test"], auditAllowed: true, approvalGate: true });
    expect(ui.text).toMatch(/Wrote team\.json/);
  });

  it("uses the default file name and a given name", async () => {
    const root = await simple();
    await exportTo(root, undefined, quiet(), { name: "acme" });
    expect(parsePresetFile(await readFile(path.join(root, "guardrails-preset.json"), "utf8")).name).toBe("acme");
  });

  it("never overwrites a file that is different, and accepts one that is the same", async () => {
    const root = await simple();
    await put(root, "team.json", "{}");
    await expect(exportTo(root, "team.json")).rejects.toThrow(/already exists and is different/);
    expect(await readFile(path.join(root, "team.json"), "utf8")).toBe("{}");

    await exportTo(root, "fresh.json", quiet(), { name: "x" });
    const ui = quiet();
    await exportTo(root, "fresh.json", ui, { name: "x" });
    expect(ui.text).toMatch(/already up to date/);
  });

  it("refuses a name that is not .json and a path outside the project", async () => {
    const root = await simple();
    await expect(exportTo(root, "team.txt")).rejects.toThrow(/must end in \.json/);
    await expect(exportTo(root, "../team.json")).rejects.toThrow(/inside the project/);
  });

  it("refuses settings a preset cannot carry", async () => {
    await expect(exportTo(await simple({ policy: "blocklist" }), "t.json")).rejects.toThrow(/blocklist/);
    await expect(exportTo(await simple({ approvalGate: false }), "t.json")).rejects.toThrow(/plan gate/);
    await expect(exportTo(await simple({ allowCommands: ["bash"] }), "t.json")).rejects.toThrow(CliError);
  });

  it("changes nothing on a dry run, asks first in a terminal, and needs --yes without one", async () => {
    const root = await simple();
    await exportTo(root, "dry.json", quiet(), { dryRun: true });
    await expect(readFile(path.join(root, "dry.json"), "utf8")).rejects.toThrow();

    await expect(runPreset({ cwd: root, ui: new ScriptedUi([false]) }, "export", { target: "no.json" })).rejects.toThrow(CancelledError);
    await expect(runPreset({ cwd: root, ui: quiet() }, "export", { target: "no.json" })).rejects.toThrow(/--yes/);
    await expect(readFile(path.join(root, "no.json"), "utf8")).rejects.toThrow();
  });
});

describe("preset use", () => {
  it("follows a preset: adds to the project, keeps its own entries, and saves where it came from", async () => {
    const root = await simple({ allowCommands: ["make lint"] });
    await put(root, "team.json", preset({ policy: "allowlist", allowCommands: ["pnpm test"], auditAllowed: true }));
    const ui = quiet();
    expect(await use(root, "./team.json", ui)).toBe(0);

    const saved = await config(root);
    expect(saved).toMatchObject({ policy: "allowlist", auditAllowed: true, extends: "./team.json" });
    expect(saved.allowCommands).toEqual(["make lint", "pnpm test"]);
    expect(saved.extendsHash).toBe(presetHash({ policy: "allowlist", allowCommands: ["pnpm test"], auditAllowed: true }));
    expect(ui.text).toContain('Team preset "acme"');
    expect(ui.text).toMatch(/WARN: This adds 1 command\(s\) that will run without asking: pnpm test/);
    expect(ui.text).toMatch(/only keep or raise protection/);
  });

  it("works with an installed package", async () => {
    const root = await simple();
    await put(root, "node_modules/@acme/guard/guardrails-preset.json", preset({ allowCommands: ["pnpm test"] }));
    await use(root, "@acme/guard");
    expect(await config(root)).toMatchObject({ extends: "@acme/guard", allowCommands: ["pnpm test"] });
  });

  it("says so when the project already follows it", async () => {
    const root = await simple();
    await put(root, "team.json", preset({ allowCommands: ["pnpm test"] }));
    await use(root, "./team.json");
    const ui = quiet();
    await use(root, "./team.json", ui);
    expect(ui.text).toMatch(/already follows/);
  });

  it("changes nothing for a preset that is not valid", async () => {
    const root = await simple();
    const before = await readFile(path.join(root, CONFIG), "utf8");
    await put(root, "bad.json", preset({ policy: "blocklist" }));
    await expect(use(root, "./bad.json")).rejects.toThrow(/not a valid preset/);
    await expect(use(root, "https://example.com/p.json")).rejects.toThrow(/never fetched/);
    await expect(use(root, undefined)).rejects.toThrow(/Say where the preset is/);
    expect(await readFile(path.join(root, CONFIG), "utf8")).toBe(before);
  });

  it("changes nothing on a dry run or a no, and needs --yes without a terminal", async () => {
    const root = await simple();
    await put(root, "team.json", preset({ allowCommands: ["pnpm test"] }));
    const before = await readFile(path.join(root, CONFIG), "utf8");
    await use(root, "./team.json", quiet(), { dryRun: true });
    await expect(runPreset({ cwd: root, ui: new ScriptedUi([false]) }, "use", { target: "./team.json" })).rejects.toThrow(CancelledError);
    await expect(runPreset({ cwd: root, ui: quiet() }, "use", { target: "./team.json" })).rejects.toThrow(/--yes/);
    expect(await readFile(path.join(root, CONFIG), "utf8")).toBe(before);
  });

  it("gives another project the same settings (export, then use)", async () => {
    const from = await simple({ policy: "allowlist", allowCommands: ["pnpm test", "pnpm build"], auditAllowed: true, checkpoints: false });
    await exportTo(from, "team.json", quiet(), { name: "acme" });
    const exported = await readFile(path.join(from, "team.json"), "utf8");

    const to = await simple();
    await put(to, "team.json", exported);
    await use(to, "./team.json");
    expect(await config(to)).toMatchObject({ policy: "allowlist", allowCommands: ["pnpm test", "pnpm build"], auditAllowed: true, extends: "./team.json" });
  });

  it("needs init to have run first", async () => {
    await expect(use(await tempProject(), "./team.json")).rejects.toThrow(/init/);
  });
});

describe("a built-in preset ends the team preset", () => {
  it("removes extends and says so", async () => {
    const root = await simple();
    await put(root, "team.json", preset({ allowCommands: ["pnpm test"] }));
    await use(root, "./team.json");
    const ui = quiet();
    await runPreset({ cwd: root, ui }, "learner", { yes: true });
    const saved = await config(root);
    expect(saved.extends).toBeUndefined();
    expect(saved.extendsHash).toBeUndefined();
    expect(saved.preset).toBe("learner");
    expect(ui.text).toMatch(/no longer follows the team preset \.\/team\.json/);
  });
});

describe("update and a team preset", () => {
  async function initialised() {
    const root = await tempProject({ "package.json": JSON.stringify({ name: "demo" }) });
    await runInit({ cwd: root, ui: quiet() }, { agents: "claude", preset: "balanced", yes: true });
    return root;
  }

  it("applies a preset that changed since the last time", async () => {
    const root = await initialised();
    await put(root, "team.json", preset({ allowCommands: ["pnpm test"] }));
    await use(root, "./team.json");
    const first = (await config(root)).extendsHash;

    await put(root, "team.json", preset({ allowCommands: ["pnpm test", "pnpm lint"], policy: "allowlist" }));
    const ui = quiet();
    expect(await runUpdate({ cwd: root, ui }, { yes: true })).toBe(0);
    const saved = await config(root);
    expect(saved.allowCommands).toEqual(["pnpm test", "pnpm lint"]);
    expect(saved.policy).toBe("allowlist");
    expect(saved.extendsHash).not.toBe(first);
    expect(ui.text).toMatch(/Following the team preset "acme" \(\.\/team\.json\)/);
  });

  it("stops when the source is missing, and when it has become invalid", async () => {
    const missing = await initialised();
    await put(missing, CONFIG, JSON.stringify({ ...(await config(missing)), extends: "./gone.json" }));
    await expect(runUpdate({ cwd: missing, ui: quiet() }, { yes: true })).rejects.toThrow(/could not be applied.*gone\.json does not exist/);

    const invalid = await initialised();
    await put(invalid, "team.json", preset({ allowCommands: ["pnpm test"] }));
    await use(invalid, "./team.json");
    await put(invalid, "team.json", preset({ policy: "blocklist" }));
    const before = await readFile(path.join(invalid, CONFIG), "utf8");
    await expect(runUpdate({ cwd: invalid, ui: quiet() }, { yes: true })).rejects.toThrow(/could not be applied/);
    expect(await readFile(path.join(invalid, CONFIG), "utf8")).toBe(before);
  });

  it("does nothing special for a project without a team preset", async () => {
    const root = await initialised();
    const ui = quiet();
    await runUpdate({ cwd: root, ui }, { yes: true });
    expect(ui.text).not.toMatch(/Following the team preset/);
    expect((await config(root)).extends).toBeUndefined();
  });
});
