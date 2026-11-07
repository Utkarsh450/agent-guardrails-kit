import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ID_A, ID_B, makeCheckpoint, put, tempProject } from "../../../tests/helpers/checkpoint-store.ts";
import { CHECKPOINT_ID, checkpointUsage, listCheckpoints, parseManifest, planRestore, readCheckpoint, readSavedFile } from "./index.ts";

const valid = { version: 1, id: ID_A, ts: "2026-11-07T10:10:00.000Z", agent: "claude", tool: "Write", files: [{ path: "a.ts", existed: true, bytes: 3 }] };

describe("manifest", () => {
  it("accepts what the guard writes", () => {
    expect(parseManifest(JSON.stringify(valid))?.files).toHaveLength(1);
    expect(parseManifest(JSON.stringify({ ...valid, files: [{ path: "a.ts", existed: true, bytes: 3, skipped: "too-big" }] }))).not.toBeNull();
  });

  it("rejects anything else", () => {
    for (const bad of ["not json", "{}", JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, id: "../../etc" }), JSON.stringify({ ...valid, files: [{ path: "", existed: true, bytes: 1 }] }), JSON.stringify({ ...valid, files: [{ path: "a", existed: true, bytes: 1, skipped: "whatever" }] })]) {
      expect(parseManifest(bad), bad).toBeNull();
    }
  });

  it("only takes ids made of a time and four hex characters", () => {
    expect(CHECKPOINT_ID.test(ID_A)).toBe(true);
    for (const bad of ["", "..", "../x", `${ID_A}/../x`, "20261107T101000000Z", "20261107T101000000Z-zzzz", ` ${ID_A}`]) expect(CHECKPOINT_ID.test(bad), bad).toBe(false);
  });
});

describe("the store", () => {
  it("lists checkpoints newest first and honours the limit", async () => {
    const root = await tempProject();
    await makeCheckpoint(root, ID_A, [{ path: "a.ts", existed: true, content: "1" }]);
    await makeCheckpoint(root, ID_B, [{ path: "b.ts", existed: true, content: "2" }]);
    expect((await listCheckpoints(root)).map((m) => m.id)).toEqual([ID_B, ID_A]);
    expect((await listCheckpoints(root, 1)).map((m) => m.id)).toEqual([ID_B]);
  });

  it("leaves out folders that are not valid checkpoints", async () => {
    const root = await tempProject();
    await makeCheckpoint(root, ID_A, [{ path: "a.ts", existed: true, content: "1" }]);
    await put(root, ".agent-guardrails/checkpoints/not-an-id/manifest.json", JSON.stringify(valid));
    await put(root, ".agent-guardrails/checkpoints/20261107T120000000Z-cccc/manifest.json", "{ half written");
    await put(root, ".agent-guardrails/checkpoints/20261107T130000000Z-dddd/manifest.json", JSON.stringify(valid)); // names a different id
    expect((await listCheckpoints(root)).map((m) => m.id)).toEqual([ID_A]);
  });

  it("returns nothing when there is no store yet", async () => {
    const root = await tempProject();
    expect(await listCheckpoints(root)).toEqual([]);
    expect(await checkpointUsage(root)).toBeNull();
    expect(await readCheckpoint(root, ID_A)).toBeNull();
  });

  it("does not follow an id that is not an id", async () => {
    const root = await tempProject({ "secret.txt": "x" });
    expect(await readCheckpoint(root, "../../secret.txt")).toBeNull();
    expect(await readSavedFile(root, "../..", "secret.txt")).toBeNull();
  });

  it("counts checkpoints and bytes from the guard's index, torn line included", async () => {
    const root = await tempProject();
    await makeCheckpoint(root, ID_A, [{ path: "a.ts", existed: true, content: "12345" }]);
    await makeCheckpoint(root, ID_B, [{ path: "b.ts", existed: true, content: "123" }]);
    expect(await checkpointUsage(root)).toEqual({ count: 2, bytes: 8 });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path.join(root, ".agent-guardrails/checkpoints/index.log"), '{"id":"x","by', "utf8");
    expect(await checkpointUsage(root)).toEqual({ count: 3, bytes: 8 });
  });

  it("reads a saved file, and refuses a path that leaves the folder", async () => {
    const root = await tempProject();
    await makeCheckpoint(root, ID_A, [{ path: "src/a.ts", existed: true, content: "original" }]);
    expect(await readSavedFile(root, ID_A, "src/a.ts")).toBe("original");
    expect(await readSavedFile(root, ID_A, "src/none.ts")).toBeNull();
    await expect(readSavedFile(root, ID_A, "../manifest.json")).rejects.toThrow();
  });
});

describe("planRestore", () => {
  async function scene() {
    const root = await tempProject({ "src/a.ts": "changed", "src/same.ts": "same", "src/made.ts": "agent made", "src/big.ts": "now", "src/link.ts": "x", "src/copy-missing.ts": "now" });
    await makeCheckpoint(root, ID_A, [
      { path: "src/a.ts", existed: true, content: "original" },
      { path: "src/same.ts", existed: true, content: "same" },
      { path: "src/gone.ts", existed: true, content: "was here" },
      { path: "src/made.ts", existed: false },
      { path: "src/big.ts", existed: true, skipped: "too-big" },
      { path: "src/copy-missing.ts", existed: true },
      { path: "../outside.txt", existed: true },
      { path: ".git/config", existed: true },
    ]);
    const manifest = await readCheckpoint(root, ID_A);
    if (manifest === null) throw new Error("test setup failed");
    return { root, manifest };
  }

  it("sorts every file into what will happen to it", async () => {
    const { root, manifest } = await scene();
    const plan = await planRestore(root, manifest);

    expect(plan.files.map((f) => [f.path, f.status, f.content, f.existing])).toEqual([
      ["src/a.ts", "update", "original", "changed"],
      ["src/gone.ts", "create", "was here", null],
    ]);
    expect(plan.unchanged).toEqual(["src/same.ts"]);
    expect(plan.createdByAgent).toEqual(["src/made.ts"]);
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]));
    expect(reasons["src/big.ts"]).toMatch(/1 MB/);
    expect(reasons["src/copy-missing.ts"]).toMatch(/missing/);
    expect(reasons["../outside.txt"]).toMatch(/not inside the project/);
    expect(reasons[".git/config"]).toMatch(/never restores/);
  });

  it("can be limited to one file", async () => {
    const { root, manifest } = await scene();
    const plan = await planRestore(root, manifest, "src/gone.ts");
    expect(plan.files.map((f) => f.path)).toEqual(["src/gone.ts"]);
    expect(plan.unchanged).toEqual([]);
    expect(plan.createdByAgent).toEqual([]);
  });

  it("does not write through a symlink", async () => {
    const root = await tempProject({ "real.ts": "x" });
    await mkdir(path.join(root, "src"), { recursive: true });
    await symlink(path.join(root, "real.ts"), path.join(root, "src/link.ts"));
    await makeCheckpoint(root, ID_A, [{ path: "src/link.ts", existed: true, content: "original" }]);
    const manifest = await readCheckpoint(root, ID_A);
    const plan = await planRestore(root, manifest!);
    expect(plan.files).toEqual([]);
    expect(plan.skipped[0]?.reason).toMatch(/not a regular file/);
  });
});
