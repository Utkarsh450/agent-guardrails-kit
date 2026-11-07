import { describe, expect, it } from "vitest";
import {
  GENERATED_MARKER,
  isGenerated,
  normalizeRelPath,
  planFiles,
  type ReadExisting,
} from "./fs-plan.ts";

const missing: ReadExisting = async () => null;

describe("normalizeRelPath", () => {
  it("accepts normal relative paths and converts backslashes", () => {
    expect(normalizeRelPath("src/a.ts")).toBe("src/a.ts");
    expect(normalizeRelPath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeRelPath("./a.ts")).toBe("a.ts");
  });

  it.each(["", "/etc/passwd", "C:/Windows/x", "../outside.md", "a/../../outside.md", ".."])(
    "rejects %j",
    (bad) => {
      expect(() => normalizeRelPath(bad)).toThrow();
    },
  );
});

describe("planFiles", () => {
  it("marks missing files as create", async () => {
    const [file] = await planFiles([{ path: "a.md", content: "x", generated: true }], missing);
    expect(file?.status).toBe("create");
  });

  it("marks identical files as unchanged", async () => {
    const read: ReadExisting = async () => ({ kind: "file", content: "x" });
    const [file] = await planFiles([{ path: "a.md", content: "x", generated: true }], read);
    expect(file?.status).toBe("unchanged");
  });

  it("updates an existing generated file", async () => {
    const read: ReadExisting = async () => ({
      kind: "file",
      content: `<!-- ${GENERATED_MARKER} -->\nold`,
    });
    const [file] = await planFiles([{ path: "a.md", content: "new", generated: true }], read);
    expect(file?.status).toBe("update");
  });

  it("never overwrites a file the kit did not generate", async () => {
    const read: ReadExisting = async () => ({ kind: "file", content: "hand written" });
    const [file] = await planFiles([{ path: "a.md", content: "new", generated: true }], read);
    expect(file?.status).toBe("conflict");
    expect(file?.reason).toMatch(/not generated/);
  });

  it("does not update a non-generated output even if the marker is present", async () => {
    const read: ReadExisting = async () => ({
      kind: "file",
      content: `<!-- ${GENERATED_MARKER} -->`,
    });
    const [file] = await planFiles([{ path: "a.md", content: "new", generated: false }], read);
    expect(file?.status).toBe("conflict");
  });

  it("treats symlinks as conflicts", async () => {
    const read: ReadExisting = async () => ({ kind: "symlink", content: "" });
    const [file] = await planFiles([{ path: "a.md", content: "new", generated: true }], read);
    expect(file?.status).toBe("conflict");
    expect(file?.reason).toMatch(/symlink/);
  });

  it("rejects duplicate targets and escaping paths", async () => {
    await expect(
      planFiles(
        [
          { path: "a.md", content: "1", generated: true },
          { path: "./a.md", content: "2", generated: true },
        ],
        missing,
      ),
    ).rejects.toThrow(/same file/);
    await expect(
      planFiles([{ path: "../x.md", content: "1", generated: true }], missing),
    ).rejects.toThrow(/inside the project/);
  });
});

describe("isGenerated", () => {
  it("only looks near the top of the file", () => {
    expect(isGenerated(`<!-- ${GENERATED_MARKER} -->`)).toBe(true);
    expect(isGenerated(`${"x".repeat(3000)}${GENERATED_MARKER}`)).toBe(false);
  });
});

describe("executable files", () => {
  it("fixes a hook whose content is right but lost its execute bit", async () => {
    const lost: ReadExisting = async () => ({ kind: "file", content: "x", executable: false });
    const [file] = await planFiles([{ path: ".githooks/pre-push", content: "x", generated: true, executable: true }], lost);
    expect(file?.status).toBe("update");

    const fine: ReadExisting = async () => ({ kind: "file", content: "x", executable: true });
    expect((await planFiles([{ path: "h", content: "x", generated: true, executable: true }], fine))[0]?.status).toBe("unchanged");

    const unknown: ReadExisting = async () => ({ kind: "file", content: "x" });
    expect((await planFiles([{ path: "h", content: "x", generated: true, executable: true }], unknown))[0]?.status).toBe("unchanged");

    const notWanted: ReadExisting = async () => ({ kind: "file", content: "x", executable: false });
    expect((await planFiles([{ path: "h", content: "x", generated: true }], notWanted))[0]?.status).toBe("unchanged");
  });
});
