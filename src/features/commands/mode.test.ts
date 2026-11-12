import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedUi } from "../../../tests/helpers/scripted-ui.ts";
import { CancelledError, CliError } from "./errors.ts";
import { runMode } from "./mode.ts";

const NOW = new Date("2026-11-07T09:00:00.000Z");
const CONFIG = "agent-guardrails.config.json";

async function project(config: object | null = { version: 1 }): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-mode-")));
  if (config !== null) await writeFile(path.join(root, CONFIG), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return root;
}
const readConfig = async (root: string) => JSON.parse(await readFile(path.join(root, CONFIG), "utf8")) as Record<string, unknown>;
const mode = (root: string, ui: ScriptedUi, name?: string, options: { days?: number; yes?: boolean } = {}) =>
  runMode({ cwd: root, ui }, name, { ...options, now: NOW });

describe("agent-guardrails-kit mode", () => {
  it("says the guard is enforcing when no mode is set", async () => {
    const ui = new ScriptedUi([], false);
    expect(await mode(await project(), ui)).toBe(0);
    expect(ui.text).toMatch(/enforcing/);
  });

  it("turns watch mode on for 7 days by default", async () => {
    const root = await project();
    const ui = new ScriptedUi([], false);
    expect(await mode(root, ui, "watch", { yes: true })).toBe(0);
    expect(await readConfig(root)).toMatchObject({ mode: "watch", watchUntil: "2026-11-14T09:00:00.000Z" });
    expect(ui.text).toMatch(/Blocked actions .* stay blocked/s);
  });

  it("uses the number of days it is given", async () => {
    const root = await project();
    await mode(root, new ScriptedUi([], false), "watch", { days: 3, yes: true });
    expect((await readConfig(root)).watchUntil).toBe("2026-11-10T09:00:00.000Z");
  });

  it("refuses a length that is not 1 to 30 whole days", async () => {
    const root = await project();
    for (const days of [0, 31, 1.5, Number.NaN, -2]) {
      await expect(mode(root, new ScriptedUi([], false), "watch", { days, yes: true })).rejects.toThrow(CliError);
    }
    expect(await readConfig(root)).toEqual({ version: 1 });
  });

  it("reports when watch mode is on, and when it has ended", async () => {
    const on = await project({ version: 1, mode: "watch", watchUntil: "2026-11-14T09:00:00.000Z" });
    const onUi = new ScriptedUi([], false);
    await mode(on, onUi);
    expect(onUi.text).toMatch(/WARN: Watch mode is ON until 2026-11-14T09:00:00.000Z/);

    const ended = await project({ version: 1, mode: "watch", watchUntil: "2026-11-01T09:00:00.000Z" });
    const endedUi = new ScriptedUi([], false);
    await mode(ended, endedUi);
    expect(endedUi.text).toMatch(/no valid end date/);
  });

  it("switches back to enforce and clears the end date", async () => {
    const root = await project();
    await mode(root, new ScriptedUi([], false), "watch", { yes: true });
    expect(await mode(root, new ScriptedUi([], false), "enforce", { yes: true })).toBe(0);
    expect(await readConfig(root)).toMatchObject({ mode: "enforce", watchUntil: null });

    const again = new ScriptedUi([], false);
    await mode(root, again, "enforce", { yes: true });
    expect(again.text).toMatch(/Already in enforce mode/);
  });

  it("keeps every other setting as it was", async () => {
    const root = await project({ version: 1, policy: "allowlist", allowCommands: ["pnpm test"], preset: "team" });
    await mode(root, new ScriptedUi([], false), "watch", { yes: true });
    expect(await readConfig(root)).toMatchObject({ policy: "allowlist", allowCommands: ["pnpm test"], preset: "team", mode: "watch" });
  });

  it("rejects an unknown mode", async () => {
    await expect(mode(await project(), new ScriptedUi([], false), "yolo", { yes: true })).rejects.toThrow(/Unknown mode/);
  });

  it("needs --yes when there is no terminal to ask in", async () => {
    const root = await project();
    await expect(mode(root, new ScriptedUi([], false), "watch")).rejects.toThrow(/--yes/);
    expect(await readConfig(root)).toEqual({ version: 1 });
  });

  it("asks first in a terminal, and changes nothing on no", async () => {
    const root = await project();
    await expect(mode(root, new ScriptedUi([false]), "watch")).rejects.toThrow(CancelledError);
    expect(await readConfig(root)).toEqual({ version: 1 });

    expect(await mode(root, new ScriptedUi([true]), "watch")).toBe(0);
    expect((await readConfig(root)).mode).toBe("watch");
  });

  it("needs init to have run first", async () => {
    await expect(mode(await project(null), new ScriptedUi([], false), "watch", { yes: true })).rejects.toThrow(/init/);
  });
});
