import { describe, expect, it } from "vitest";
import type { ReadExisting } from "./fs-plan.ts";
import { MergeError, addToStringList, ensureObject, planJsonConfig } from "./json-config.ts";

const read =
  (content: string | null, kind: "file" | "symlink" | "other" = "file"): ReadExisting =>
  async () => (content === null ? null : { kind, content });

const setFlag = (config: Record<string, unknown>) => ({ ...config, flag: true });

describe("planJsonConfig", () => {
  it("creates a missing file", async () => {
    const plan = await planJsonConfig("a/b.json", read(null), setFlag);
    expect(plan).toMatchObject({ status: "create", path: "a/b.json", existing: null });
    expect(JSON.parse(plan.content)).toEqual({ flag: true });
    expect(plan.content.endsWith("\n")).toBe(true);
  });

  it("keeps every other key and the file's indentation", async () => {
    const existing = '{\n    "model": "x",\n    "nested": { "a": [1, 2] }\n}\n';
    const plan = await planJsonConfig("c.json", read(existing), setFlag);
    expect(plan.status).toBe("update");
    expect(JSON.parse(plan.content)).toEqual({ model: "x", nested: { a: [1, 2] }, flag: true });
    expect(plan.content).toMatch(/\n {4}"model"/);

    const tabs = await planJsonConfig("c.json", read('{\n\t"model": "x"\n}\n'), setFlag);
    expect(tabs.content).toMatch(/\n\t"model"/);
  });

  it("reports unchanged when the edit changes nothing", async () => {
    const first = await planJsonConfig("c.json", read(null), setFlag);
    const second = await planJsonConfig("c.json", read(first.content), setFlag);
    expect(second.status).toBe("unchanged");
  });

  it("treats an empty file as an empty object and ignores a BOM", async () => {
    expect((await planJsonConfig("c.json", read("  \n"), setFlag)).status).toBe("update");
    const bom = await planJsonConfig("c.json", read(`﻿{"a":1}`), setFlag);
    expect(JSON.parse(bom.content)).toEqual({ a: 1, flag: true });
  });

  it("never touches a file it cannot understand", async () => {
    const comments = await planJsonConfig("c.json", read('{\n // note\n "a": 1\n}'), setFlag);
    expect(comments.status).toBe("conflict");
    expect(comments.reason).toMatch(/not valid JSON/);

    expect((await planJsonConfig("c.json", read("[1,2]"), setFlag)).status).toBe("conflict");
    expect((await planJsonConfig("c.json", read('"text"'), setFlag)).status).toBe("conflict");
    expect((await planJsonConfig("c.json", read("{ trailing, }"), setFlag)).status).toBe("conflict");
  });

  it("never writes through symlinks or onto directories", async () => {
    expect((await planJsonConfig("c.json", read("", "symlink"), setFlag)).status).toBe("conflict");
    expect((await planJsonConfig("c.json", read("", "other"), setFlag)).status).toBe("conflict");
  });

  it("turns a structural surprise into a conflict instead of crashing", async () => {
    const plan = await planJsonConfig("c.json", read('{"hooks":"oops"}'), (config) => {
      ensureObject(config, "hooks", "settings");
      return config;
    });
    expect(plan.status).toBe("conflict");
    expect(plan.reason).toMatch(/settings\.hooks is not a JSON object/);
  });

  it("does not leak half-finished edits when the transform throws", async () => {
    const original = '{"a":1}';
    const plan = await planJsonConfig("c.json", read(original), (config) => {
      config.partial = true;
      throw new MergeError("nope");
    });
    expect(plan.status).toBe("conflict");
    expect(plan.content).toBe("");
  });

  it("rejects paths that leave the project", async () => {
    await expect(planJsonConfig("../x.json", read(null), setFlag)).rejects.toThrow();
  });

  it("rethrows unexpected errors", async () => {
    await expect(
      planJsonConfig("c.json", read(null), () => {
        throw new TypeError("bug");
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe("addToStringList", () => {
  it("adds only missing entries and keeps the existing order", () => {
    const config: Record<string, unknown> = { deny: ["b", "a"] };
    addToStringList(config, "deny", "permissions", ["a", "c", "b", "d"]);
    expect(config.deny).toEqual(["b", "a", "c", "d"]);
  });

  it("creates the list and refuses a non-list", () => {
    const config: Record<string, unknown> = {};
    addToStringList(config, "deny", "permissions", ["x"]);
    expect(config.deny).toEqual(["x"]);
    expect(() => addToStringList({ deny: "x" }, "deny", "permissions", ["y"])).toThrow(MergeError);
  });
});
