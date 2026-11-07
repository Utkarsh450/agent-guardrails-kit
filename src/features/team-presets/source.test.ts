import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { put, tempProject } from "../../../tests/helpers/checkpoint-store.ts";
import { PRESET_KIND, PresetError, loadPresetFromSource } from "./index.ts";

const preset = (settings: object = { allowCommands: ["pnpm test"] }, name = "acme") => JSON.stringify({ kind: PRESET_KIND, version: 1, name, settings });

describe("loading a preset from disk", () => {
  it("reads a file in the project", async () => {
    const root = await tempProject({ "team.json": preset() });
    const loaded = await loadPresetFromSource(root, "team.json");
    expect(loaded.source).toBe("./team.json");
    expect(loaded.preset.name).toBe("acme");
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads an installed package, plain and scoped", async () => {
    const root = await tempProject({ "node_modules/acme-guard/guardrails-preset.json": preset(), "node_modules/@acme/guard/guardrails-preset.json": preset({}, "scoped") });
    expect((await loadPresetFromSource(root, "acme-guard")).source).toBe("acme-guard");
    expect((await loadPresetFromSource(root, "@acme/guard")).preset.name).toBe("scoped");
  });

  it("follows a pnpm-style link that stays inside the project", async () => {
    const root = await tempProject({ "node_modules/.pnpm/acme-guard@1.0.0/node_modules/acme-guard/guardrails-preset.json": preset() });
    await symlink(path.join(root, "node_modules/.pnpm/acme-guard@1.0.0/node_modules/acme-guard"), path.join(root, "node_modules/acme-guard"));
    expect((await loadPresetFromSource(root, "acme-guard")).preset.settings.allowCommands).toEqual(["pnpm test"]);
  });

  it("refuses a link that leads outside the project", async () => {
    const outside = await tempProject({ "guardrails-preset.json": preset(), "p.json": preset() });
    const root = await tempProject();
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await symlink(outside, path.join(root, "node_modules/evil"));
    await symlink(path.join(outside, "p.json"), path.join(root, "link.json"));
    await expect(loadPresetFromSource(root, "evil")).rejects.toThrow(/outside the project/);
    await expect(loadPresetFromSource(root, "./link.json")).rejects.toThrow(/outside the project/);
  });

  it("says plainly when the source is missing", async () => {
    const root = await tempProject();
    await expect(loadPresetFromSource(root, "./nope.json")).rejects.toThrow(/nope\.json does not exist/);
    await expect(loadPresetFromSource(root, "@acme/guard")).rejects.toThrow(/not installed here.*Install it yourself/);
  });

  it("refuses something that is not a small regular file", async () => {
    const root = await tempProject({ "dir.json/x.txt": "x" });
    await expect(loadPresetFromSource(root, "./dir.json")).rejects.toThrow(/not a file/);
    await put(root, "big.json", preset({}, "x".repeat(40)) + " ".repeat(70 * 1024));
    await expect(loadPresetFromSource(root, "./big.json")).rejects.toThrow(/bigger than 64 KB/);
  });

  it("names the file when the content is wrong", async () => {
    const root = await tempProject({ "bad.json": "{ nope", "blocked.json": preset({ policy: "blocklist" }), "keys.json": preset({ mode: "watch" }) });
    await expect(loadPresetFromSource(root, "./bad.json")).rejects.toThrow(/bad\.json is not valid JSON/);
    await expect(loadPresetFromSource(root, "./blocked.json")).rejects.toThrow(/blocked\.json is not a valid preset/);
    await expect(loadPresetFromSource(root, "./keys.json")).rejects.toThrow(/mode/);
  });

  it("refuses a preset that allows a command that can never be allowed", async () => {
    const root = await tempProject({ "p.json": preset({ allowCommands: ["pnpm test", "bash", "rm -rf build"] }) });
    const error = await loadPresetFromSource(root, "./p.json").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PresetError);
    expect((error as Error).message).toMatch(/cannot be allowed.*"bash".*"rm -rf build"/);
  });

  it("never fetches", async () => {
    await expect(loadPresetFromSource(await tempProject(), "https://example.com/p.json")).rejects.toThrow(/never fetched/);
  });
});
