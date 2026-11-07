import { describe, expect, it } from "vitest";
import { parseRule } from "./parse.ts";
import { RuleError } from "./types.ts";

const base = { sourcePath: "agent-rules/always/x.md", name: "x" } as const;

describe("parseRule", () => {
  it("parses an always rule", () => {
    const rule = parseRule({
      ...base,
      scope: "always",
      raw: "---\ndescription: Be safe\n---\n\n# Title\n\nBody\n",
    });
    expect(rule).toMatchObject({
      name: "x",
      scope: "always",
      description: "Be safe",
      globs: [],
      body: "# Title\n\nBody",
    });
  });

  it("parses a scoped rule with globs", () => {
    const rule = parseRule({
      ...base,
      scope: "scoped",
      raw: '---\ndescription: DB\nglobs:\n  - "**/*.sql"\n---\nBody\n',
    });
    expect(rule.globs).toEqual(["**/*.sql"]);
  });

  it("handles Windows line endings and a BOM", () => {
    const rule = parseRule({
      ...base,
      scope: "always",
      raw: "﻿---\r\ndescription: Hi\r\n---\r\nLine one\r\nLine two\r\n",
    });
    expect(rule.body).toBe("Line one\nLine two");
  });

  it("explains missing frontmatter", () => {
    expect(() => parseRule({ ...base, scope: "always", raw: "# no frontmatter" })).toThrow(
      /missing frontmatter/,
    );
  });

  it("requires a description", () => {
    expect(() =>
      parseRule({ ...base, scope: "always", raw: "---\nglobs: []\n---\nBody" }),
    ).toThrow(RuleError);
  });

  it("requires globs on scoped rules", () => {
    expect(() =>
      parseRule({ ...base, scope: "scoped", raw: "---\ndescription: D\n---\nBody" }),
    ).toThrow(/globs/);
  });

  it("rejects invalid YAML and empty bodies", () => {
    expect(() =>
      parseRule({ ...base, scope: "always", raw: "---\ndescription: [unclosed\n---\nBody" }),
    ).toThrow(/not valid YAML/);
    expect(() =>
      parseRule({ ...base, scope: "always", raw: "---\ndescription: D\n---\n\n" }),
    ).toThrow(/no content/);
  });
});
