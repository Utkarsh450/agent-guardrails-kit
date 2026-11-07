import { describe, expect, it } from "vitest";
import type { ReadExisting } from "./fs-plan.ts";
import { blockMarkers, planTextBlock, planTextBlocks } from "./text-block.ts";

const read = (content: string | null, kind: "file" | "symlink" | "other" = "file"): ReadExisting => async () =>
  content === null ? null : { kind, content };

const lines = [".env", ".env.*", "!.env.example"];

describe("planTextBlock", () => {
  it("creates a missing file holding just the block", async () => {
    const plan = await planTextBlock(".gitignore", "secrets", lines, read(null));
    expect(plan.status).toBe("create");
    expect(plan.content).toBe(`${blockMarkers("secrets").begin}\n.env\n.env.*\n!.env.example\n${blockMarkers("secrets").end}\n`);
  });

  it("appends after the user's lines without touching them", async () => {
    const plan = await planTextBlock(".gitignore", "secrets", lines, read("node_modules/\ndist/\n"));
    expect(plan.status).toBe("update");
    expect(plan.content.startsWith("node_modules/\ndist/\n\n# >>> agent-guardrails:secrets")).toBe(true);
    expect(plan.content.endsWith("# <<< agent-guardrails:secrets\n")).toBe(true);
  });

  it("handles a file with no trailing newline and an empty file", async () => {
    expect((await planTextBlock("f", "x", ["a"], read("keep"))).content.startsWith("keep\n\n# >>>")).toBe(true);
    expect((await planTextBlock("f", "x", ["a"], read(""))).content.startsWith("# >>>")).toBe(true);
  });

  it("is idempotent", async () => {
    const first = await planTextBlock(".gitignore", "secrets", lines, read("a\n"));
    const second = await planTextBlock(".gitignore", "secrets", lines, read(first.content));
    expect(second.status).toBe("unchanged");
  });

  it("refreshes only its own block and keeps lines around it", async () => {
    const first = await planTextBlock(".gitignore", "secrets", ["old"], read("before\n"));
    const withAfter = `${first.content}after-line\n`;
    const next = await planTextBlock(".gitignore", "secrets", ["new1", "new2"], read(withAfter));
    expect(next.status).toBe("update");
    expect(next.content).toContain("before\n");
    expect(next.content).toContain("new1\nnew2\n");
    expect(next.content).not.toContain("old");
    expect(next.content.endsWith("after-line\n")).toBe(true);
  });

  it("keeps different blocks apart", async () => {
    const a = await planTextBlock("f", "one", ["1"], read(null));
    const b = await planTextBlock("f", "two", ["2"], read(a.content));
    expect(b.content).toContain("agent-guardrails:one");
    expect(b.content).toContain("agent-guardrails:two");
  });

  it("refuses a damaged or duplicated block and odd files", async () => {
    const { begin, end } = blockMarkers("secrets");
    expect((await planTextBlock("f", "secrets", ["a"], read(`${begin}\nx\n`))).status).toBe("conflict");
    expect((await planTextBlock("f", "secrets", ["a"], read(`${begin}\n${end}\n${begin}\n${end}\n`))).status).toBe("conflict");
    expect((await planTextBlock("f", "secrets", ["a"], read("", "symlink"))).status).toBe("conflict");
    expect((await planTextBlock("f", "secrets", ["a"], read("", "other"))).status).toBe("conflict");
  });

  it("rejects paths outside the project", async () => {
    await expect(planTextBlock("../x", "a", [], read(null))).rejects.toThrow();
  });
});

describe("planTextBlocks", () => {
  it("writes several blocks in one edit and is idempotent", async () => {
    const first = await planTextBlocks(".gitignore", [{ id: "state", lines: ["a"] }, { id: "secrets", lines: [".env"] }], read("node_modules/\n"));
    expect(first.status).toBe("update");
    expect(first.content).toContain("node_modules/");
    expect(first.content.indexOf("agent-guardrails:state")).toBeLessThan(first.content.indexOf("agent-guardrails:secrets"));
    const again = await planTextBlocks(".gitignore", [{ id: "state", lines: ["a"] }, { id: "secrets", lines: [".env"] }], read(first.content));
    expect(again.status).toBe("unchanged");
  });

  it("creates the file when it is missing", async () => {
    const plan = await planTextBlocks(".gitignore", [{ id: "a", lines: ["1"] }, { id: "b", lines: ["2"] }], read(null));
    expect(plan.status).toBe("create");
    expect(plan.content).toContain("1");
    expect(plan.content).toContain("2");
  });

  it("refreshes one block and appends the other", async () => {
    const one = await planTextBlocks("f", [{ id: "a", lines: ["old"] }], read("keep\n"));
    const both = await planTextBlocks("f", [{ id: "a", lines: ["new"] }, { id: "b", lines: ["added"] }], read(one.content));
    expect(both.content).toContain("new");
    expect(both.content).not.toContain("old");
    expect(both.content).toContain("added");
    expect(both.content.startsWith("keep\n")).toBe(true);
  });

  it("conflicts, writing nothing, if any block is damaged", async () => {
    const { begin } = blockMarkers("b");
    const plan = await planTextBlocks("f", [{ id: "a", lines: ["1"] }, { id: "b", lines: ["2"] }], read(`${begin}\nno end`));
    expect(plan.status).toBe("conflict");
    expect(plan.content).toBe("");
  });
});
