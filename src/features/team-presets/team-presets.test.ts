import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type GuardrailsConfig } from "../../shared/config.ts";
import { PRESET_KIND, PresetError, buildPresetFromConfig, checkAllowCommands, isBehind, mergeSettings, parsePresetFile, parseSource, presetHash, serializePreset } from "./index.ts";

const project = (extra: Partial<GuardrailsConfig> = {}): GuardrailsConfig => ({ ...DEFAULT_CONFIG, ...extra });
const file = (settings: object, extra: object = {}) => JSON.stringify({ kind: PRESET_KIND, version: 1, name: "acme", settings, ...extra });

describe("the preset file", () => {
  it("accepts a small valid preset", () => {
    const preset = parsePresetFile(file({ policy: "allowlist", allowCommands: ["pnpm test"], gitAllow: ["status", "ls-files"], approvalGate: true, auditAllowed: true, alwaysRuleFiles: false, checkpoints: true }, { description: "Acme defaults" }));
    expect(preset.name).toBe("acme");
    expect(preset.settings.allowCommands).toEqual(["pnpm test"]);
    expect(parsePresetFile(file({})).settings).toEqual({});
  });

  it("refuses anything that is not one", () => {
    const bad: Array<[string, string]> = [
      ["not json", "valid JSON"],
      [JSON.stringify({ kind: "something-else", version: 1, name: "x", settings: {} }), "kind"],
      [JSON.stringify({ kind: PRESET_KIND, version: 2, name: "x", settings: {} }), "version"],
      [file({}, { name: "" }), "name"],
      [file({}, { name: "x".repeat(61) }), "name"],
      [file({}, { surprise: 1 }), "surprise"],
      [JSON.stringify({ kind: PRESET_KIND, version: 1, name: "x" }), "settings"],
    ];
    for (const [text, mention] of bad) expect(() => parsePresetFile(text), mention).toThrow(new RegExp(mention));
  });

  it("refuses every setting a preset may not carry", () => {
    for (const key of ["mode", "watchUntil", "agents", "stack", "preset", "github", "planFile", "extends", "extendsHash", "version"]) {
      expect(() => parsePresetFile(file({ [key]: key === "agents" ? ["claude"] : "x" })), key).toThrow(new RegExp(key));
    }
  });

  it("refuses values that would lower protection", () => {
    expect(() => parsePresetFile(file({ policy: "blocklist" }))).toThrow(/policy/);
    expect(() => parsePresetFile(file({ approvalGate: false }))).toThrow(/approvalGate/);
    expect(() => parsePresetFile(file({ gitAllow: ["push"] }))).toThrow(/read-only git command/);
    expect(() => parsePresetFile(file({ gitAllow: ["status", "commit"] }))).toThrow(/gitAllow/);
    expect(() => parsePresetFile(file({ allowCommands: "pnpm test" }))).toThrow(/allowCommands/);
    expect(() => parsePresetFile(file({ allowCommands: [""] }))).toThrow(/allowCommands/);
  });
});

describe("allowed commands in a preset", () => {
  it("accepts ordinary commands", () => {
    expect(checkAllowCommands(["pnpm test", "pytest", "node scripts/build.mjs", "  pnpm   lint "])).toEqual([]);
  });

  it("refuses a star, a bare program that runs any script, and commands that are blocked or still ask", () => {
    const problems = checkAllowCommands(["*", "bash", "node", "rm -rf build", "git push", 'python -c "print(1)"', "watch ls"]);
    const byEntry = Object.fromEntries(problems.map((p) => [p.entry, p.reason]));
    expect(byEntry["*"]).toMatch(/every command/);
    expect(byEntry.bash).toMatch(/any bash script/);
    expect(byEntry.node).toMatch(/any node script/);
    expect(byEntry["rm -rf build"]).toMatch(/always blocked/);
    expect(byEntry["git push"]).toMatch(/always blocked/);
    expect(byEntry['python -c "print(1)"']).toMatch(/still ask/);
    expect(byEntry["watch ls"]).toMatch(/still ask/);
  });
});

describe("combining a preset with a project", () => {
  it("keeps the stricter policy", () => {
    expect(mergeSettings(project({ policy: "ask" }), { policy: "allowlist" }).policy).toBe("allowlist");
    expect(mergeSettings(project({ policy: "allowlist" }), { policy: "ask" }).policy).toBe("allowlist");
    expect(mergeSettings(project({ policy: "blocklist" }), { policy: "ask" }).policy).toBe("ask");
    expect(mergeSettings(project({ policy: "blocklist" }), {}).policy).toBe("blocklist");
  });

  it("joins the lists and keeps the project's own entries first", () => {
    const merged = mergeSettings(project({ allowCommands: ["make lint", "pnpm test"], gitAllow: ["status"] }), { allowCommands: ["pnpm   test", "pnpm build"], gitAllow: ["diff", "status"] });
    expect(merged.allowCommands).toEqual(["make lint", "pnpm test", "pnpm build"]);
    expect(merged.gitAllow).toEqual(["status", "diff"]);
  });

  it("lets protection switch on but never off", () => {
    const on = mergeSettings(project({ auditAllowed: false, alwaysRuleFiles: false, checkpoints: false, approvalGate: false }), { auditAllowed: true, alwaysRuleFiles: true, checkpoints: true, approvalGate: true });
    expect(on).toMatchObject({ auditAllowed: true, alwaysRuleFiles: true, checkpoints: true, approvalGate: true });

    const kept = mergeSettings(project({ auditAllowed: true, alwaysRuleFiles: true, checkpoints: true, approvalGate: true }), { auditAllowed: false, alwaysRuleFiles: false, checkpoints: false });
    expect(kept).toMatchObject({ auditAllowed: true, alwaysRuleFiles: true, checkpoints: true, approvalGate: true });
  });

  it("leaves a setting alone when the preset does not mention it", () => {
    const merged = mergeSettings(project({ auditAllowed: false, checkpoints: false }), {});
    expect(merged).toMatchObject({ auditAllowed: false, checkpoints: false, policy: "ask" });
  });

  it("knows when a project is behind its preset", () => {
    const preset = { allowCommands: ["pnpm test"], policy: "allowlist" as const };
    expect(isBehind(project(), preset)).toBe(true);
    expect(isBehind(project({ allowCommands: ["pnpm test"], policy: "allowlist" }), preset)).toBe(false);
    expect(isBehind(project({ allowCommands: ["pnpm test", "extra"], policy: "allowlist" }), preset)).toBe(false);
    expect(isBehind(project(), {})).toBe(false);
  });
});

describe("fingerprint", () => {
  it("ignores the order of entries and extra spaces, and changes with the content", () => {
    expect(presetHash({ allowCommands: ["b", "a  x"], gitAllow: ["log", "diff"] })).toBe(presetHash({ allowCommands: ["a x", "b"], gitAllow: ["diff", "log"] }));
    expect(presetHash({ allowCommands: ["a"] })).not.toBe(presetHash({ allowCommands: ["a", "b"] }));
    expect(presetHash({ policy: "ask" })).not.toBe(presetHash({ policy: "allowlist" }));
    expect(presetHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("where a preset comes from", () => {
  it("takes a file in the project, with or without ./", () => {
    expect(parseSource("./team.json")).toEqual({ text: "./team.json", rel: "team.json", kind: "file" });
    expect(parseSource("team.json")).toMatchObject({ text: "./team.json", kind: "file" });
    expect(parseSource("config/team")).toMatchObject({ text: "./config/team", rel: "config/team", kind: "file" });
  });

  it("takes an installed package, plain or scoped", () => {
    expect(parseSource("acme-guard")).toEqual({ text: "acme-guard", rel: "node_modules/acme-guard/guardrails-preset.json", kind: "package" });
    expect(parseSource("@acme/guard")).toEqual({ text: "@acme/guard", rel: "node_modules/@acme/guard/guardrails-preset.json", kind: "package" });
  });

  it("refuses URLs, git addresses and paths that leave the project", () => {
    for (const bad of ["https://example.com/p.json", "http://x/p.json", "git@github.com:acme/p.git", "git+ssh://x/p", "github:acme/p", "file:///etc/passwd", "//host/share/p.json", "../p.json", "a/../../p.json", "/etc/p.json", "C:\\p.json"]) {
      expect(() => parseSource(bad), bad).toThrow(PresetError);
    }
  });

  it("refuses an empty or malformed name", () => {
    for (const bad of ["", "   ", "Bad Name!", "UPPER", "@acme", "a b"]) expect(() => parseSource(bad), bad).toThrow(PresetError);
  });
});

describe("exporting", () => {
  it("builds a preset the same reader accepts, and gives the same thing back", () => {
    const preset = buildPresetFromConfig(project({ policy: "allowlist", allowCommands: ["pnpm test"], gitAllow: ["status", "diff"], auditAllowed: true }), "acme", "Acme defaults");
    expect(preset).toMatchObject({ kind: PRESET_KIND, version: 1, name: "acme", description: "Acme defaults" });
    expect(preset.settings).toMatchObject({ policy: "allowlist", allowCommands: ["pnpm test"], approvalGate: true, auditAllowed: true, checkpoints: true });
    expect(parsePresetFile(serializePreset(preset))).toEqual(preset);
    expect(serializePreset(preset).endsWith("\n")).toBe(true);
  });

  it("refuses settings a preset cannot carry", () => {
    expect(() => buildPresetFromConfig(project({ policy: "blocklist" }), "x")).toThrow(/blocklist/);
    expect(() => buildPresetFromConfig(project({ approvalGate: false }), "x")).toThrow(/plan gate/);
    expect(() => buildPresetFromConfig(project({ allowCommands: ["bash"] }), "x")).toThrow(/any bash script/);
    expect(() => buildPresetFromConfig(project({ gitAllow: ["status", "push"] }), "x")).toThrow(PresetError);
  });
});
