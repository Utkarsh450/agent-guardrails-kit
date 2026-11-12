import { describe, expect, it } from "vitest";
import { ID_A, ID_B, makeCheckpoint, tempProject } from "../../../tests/helpers/checkpoint-store.ts";
import { ScriptedUi } from "../../../tests/helpers/scripted-ui.ts";
import { CliError } from "./errors.ts";
import { runCheckpoints } from "./checkpoints.ts";

const ESC = String.fromCharCode(27);

describe("agent-guardrails checkpoints", () => {
  it("says so when nothing has been saved", async () => {
    const ui = new ScriptedUi([], false);
    expect(await runCheckpoints({ cwd: await tempProject(), ui })).toBe(0);
    expect(ui.text).toMatch(/No checkpoints yet/);
  });

  it("says so when checkpoints are switched off", async () => {
    const ui = new ScriptedUi([], false);
    const root = await tempProject({ "agent-guardrails.config.json": JSON.stringify({ version: 1, checkpoints: false }) });
    await runCheckpoints({ cwd: root, ui });
    expect(ui.text).toMatch(/switched off/);
  });

  it("lists the newest first with a usage line", async () => {
    const root = await tempProject();
    await makeCheckpoint(root, ID_A, [{ path: "a.ts", existed: true, content: "1" }]);
    await makeCheckpoint(root, ID_B, [{ path: "b.ts", existed: true, content: "22" }, { path: "c.ts", existed: false }], { agent: "codex", tool: "apply_patch" });
    const ui = new ScriptedUi([], false);
    await runCheckpoints({ cwd: root, ui });
    const lines = ui.lines;
    expect(lines.findIndex((l) => l.startsWith(ID_B))).toBeLessThan(lines.findIndex((l) => l.startsWith(ID_A)));
    expect(ui.text).toContain("codex");
    expect(ui.text).toContain("2 file(s)  b.ts, c.ts");
    expect(ui.text).toMatch(/2 saved \(limit 1000\)/);
  });

  it("honours --limit", async () => {
    const root = await tempProject();
    await makeCheckpoint(root, ID_A, [{ path: "a.ts", existed: true, content: "1" }]);
    await makeCheckpoint(root, ID_B, [{ path: "b.ts", existed: true, content: "2" }]);
    const ui = new ScriptedUi([], false);
    await runCheckpoints({ cwd: root, ui }, undefined, { limit: 1 });
    expect(ui.text).toContain(ID_B);
    expect(ui.text).not.toContain(ID_A);
  });

  it("shows what one checkpoint holds", async () => {
    const root = await tempProject();
    await makeCheckpoint(root, ID_A, [
      { path: "a.ts", existed: true, content: "original" },
      { path: "new.ts", existed: false },
      { path: "big.bin", existed: true, skipped: "too-big" },
    ]);
    const ui = new ScriptedUi([], false);
    await runCheckpoints({ cwd: root, ui }, ID_A);
    expect(ui.text).toContain("a.ts: saved, 1 KB");
    expect(ui.text).toContain("new.ts: did not exist (the agent created it)");
    expect(ui.text).toContain("big.bin: not saved: it is bigger than the 1 MB limit");
    expect(ui.text).toContain(`agent-guardrails restore ${ID_A}`);
  });

  it("refuses an id that is not an id, and one that is not there", async () => {
    const root = await tempProject();
    await expect(runCheckpoints({ cwd: root, ui: new ScriptedUi([], false) }, "../../etc")).rejects.toThrow(CliError);
    await expect(runCheckpoints({ cwd: root, ui: new ScriptedUi([], false) }, ID_A)).rejects.toThrow(/No checkpoint/);
  });

  // Windows cannot create a file name with a control character, so there is nothing to show there.
  it.skipIf(process.platform === "win32")("removes control characters from file names", async () => {
    const root = await tempProject();
    await makeCheckpoint(root, ID_A, [{ path: `src/${ESC}[2Jevil.ts`, existed: true, content: "x" }]);
    const ui = new ScriptedUi([], false);
    await runCheckpoints({ cwd: root, ui });
    await runCheckpoints({ cwd: root, ui }, ID_A);
    expect(ui.text.includes(ESC)).toBe(false);
  });
});
