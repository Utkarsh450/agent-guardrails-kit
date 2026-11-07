import { describe, expect, it } from "vitest";
import { parseRule } from "../parse.ts";
import { defaultRuleSources } from "./index.ts";

describe("default rule templates", () => {
  it.each(defaultRuleSources.map((source) => [source.path, source] as const))(
    "%s parses as a valid rule",
    (_path, source) => {
      const [scope, file] = source.path.split("/");
      expect(scope === "always" || scope === "scoped").toBe(true);
      const rule = parseRule({
        sourcePath: `agent-rules/${source.path}`,
        scope: scope as "always" | "scoped",
        name: (file ?? "").replace(/\.md$/, ""),
        raw: source.content,
      });
      expect(rule.body.length).toBeGreaterThan(50);
    },
  );

  it("includes the core guardrails from the project notes", () => {
    const all = defaultRuleSources.map((source) => source.content).join("\n");
    expect(all).toMatch(/Do not create, edit, move or delete any file before the user approves/);
    expect(all).toMatch(/File deletion/);
    expect(all).toMatch(/`gh` commands/);
    expect(all).toMatch(/Stay inside this folder/);
    expect(all).toMatch(/feature-based/);
  });

  it("has unique paths", () => {
    const paths = defaultRuleSources.map((source) => source.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
