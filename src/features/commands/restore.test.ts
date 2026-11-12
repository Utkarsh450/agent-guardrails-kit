import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ID_A, makeCheckpoint, tempProject } from "../../../tests/helpers/checkpoint-store.ts";
import { ScriptedUi } from "../../../tests/helpers/scripted-ui.ts";
import { CancelledError, CliError } from "./errors.ts";
import { runRestore } from "./restore.ts";

const read = (root: string, rel: string) => readFile(path.join(root, ...rel.split("/")), "utf8");
const exists = (root: string, rel: string) => read(root, rel).then(() => true, () => false);

async function scene() {
  const root = await tempProject({ "src/a.ts": "changed", "src/b.ts": "b changed", "src/made.ts": "agent made" });
  await makeCheckpoint(root, ID_A, [
    { path: "src/a.ts", existed: true, content: "original" },
    { path: "src/b.ts", existed: true, content: "b original" },
    { path: "src/made.ts", existed: false },
  ]);
  return root;
}

describe("agent-guardrails-kit restore", () => {
  it("puts the saved content back, shows the diff, and keeps the checkpoint", async () => {
    const root = await scene();
    const ui = new ScriptedUi([], false);
    expect(await runRestore({ cwd: root, ui }, ID_A, { yes: true })).toBe(0);
    expect(await read(root, "src/a.ts")).toBe("original");
    expect(await read(root, "src/b.ts")).toBe("b original");
    expect(ui.text).toContain("-changed");
    expect(ui.text).toContain("+original");
    expect(ui.text).toMatch(/Restored 2 file\(s\)/);
    expect(await exists(root, `.agent-guardrails/checkpoints/${ID_A}/manifest.json`)).toBe(true);
  });

  it("never deletes a file the agent created", async () => {
    const root = await scene();
    const ui = new ScriptedUi([], false);
    await runRestore({ cwd: root, ui }, ID_A, { yes: true });
    expect(await read(root, "src/made.ts")).toBe("agent made");
    expect(ui.text).toMatch(/src\/made\.ts was created by the agent\. Restore never deletes/);
  });

  it("asks first in a terminal, and changes nothing on no", async () => {
    const root = await scene();
    await expect(runRestore({ cwd: root, ui: new ScriptedUi([false]) }, ID_A)).rejects.toThrow(CancelledError);
    expect(await read(root, "src/a.ts")).toBe("changed");

    expect(await runRestore({ cwd: root, ui: new ScriptedUi([true]) }, ID_A)).toBe(0);
    expect(await read(root, "src/a.ts")).toBe("original");
  });

  it("needs --yes when there is no terminal to ask in", async () => {
    const root = await scene();
    await expect(runRestore({ cwd: root, ui: new ScriptedUi([], false) }, ID_A)).rejects.toThrow(/--yes/);
    expect(await read(root, "src/a.ts")).toBe("changed");
  });

  it("can restore one file", async () => {
    const root = await scene();
    await runRestore({ cwd: root, ui: new ScriptedUi([], false) }, ID_A, { file: "src/b.ts", yes: true });
    expect(await read(root, "src/b.ts")).toBe("b original");
    expect(await read(root, "src/a.ts")).toBe("changed");
  });

  it("refuses a file the checkpoint does not hold, and a path outside the project", async () => {
    const root = await scene();
    await expect(runRestore({ cwd: root, ui: new ScriptedUi([], false) }, ID_A, { file: "src/zzz.ts", yes: true })).rejects.toThrow(/no file/);
    await expect(runRestore({ cwd: root, ui: new ScriptedUi([], false) }, ID_A, { file: "../x.ts", yes: true })).rejects.toThrow(/inside the project/);
  });

  it("refuses an id that is not an id, and one that is not there", async () => {
    const root = await scene();
    await expect(runRestore({ cwd: root, ui: new ScriptedUi([], false) }, "../../etc", { yes: true })).rejects.toThrow(CliError);
    await expect(runRestore({ cwd: root, ui: new ScriptedUi([], false) }, "20250101T000000000Z-ffff", { yes: true })).rejects.toThrow(/No checkpoint/);
  });

  it("says there is nothing to do when the files already match", async () => {
    const root = await tempProject({ "a.ts": "same" });
    await makeCheckpoint(root, ID_A, [{ path: "a.ts", existed: true, content: "same" }]);
    const ui = new ScriptedUi([], false);
    expect(await runRestore({ cwd: root, ui }, ID_A, { yes: true })).toBe(0);
    expect(ui.text).toMatch(/already match/);
    expect(ui.text).toMatch(/Nothing to put back/);
  });

  it("will not write outside the project, whatever a manifest says", async () => {
    const root = await tempProject({ "a.ts": "x" });
    await makeCheckpoint(root, ID_A, [{ path: "../escaped.txt", existed: true, content: "gotcha" }, { path: "a.ts", existed: true, content: "y" }]);
    const ui = new ScriptedUi([], false);
    await runRestore({ cwd: root, ui }, ID_A, { yes: true });
    expect(ui.text).toMatch(/cannot be restored: the path is not inside the project/);
    expect(await exists(path.dirname(root), "escaped.txt")).toBe(false);
    expect(await read(root, "a.ts")).toBe("y");
  });
});
