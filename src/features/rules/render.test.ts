import { describe, expect, it } from "vitest";
import { GENERATED_MARKER } from "../../shared/fs-plan.ts";
import { parse as parseYaml } from "yaml";
import { renderAgentRule, renderAgentsMd, renderClaudeMd, renderGeminiMd } from "./render.ts";
import type { Rule } from "./types.ts";

const always: Rule = {
  name: "safety",
  scope: "always",
  description: "Stay safe",
  globs: [],
  body: "# Safety\n\nNever delete.",
  sourcePath: "agent-rules/always/safety.md",
};

const scoped: Rule = {
  name: "database",
  scope: "scoped",
  description: "DB | files",
  globs: ["**/*.sql", "**/migrations/**"],
  body: "# Database\n\nRead only.",
  sourcePath: "agent-rules/scoped/database.md",
};

describe("renderAgentsMd", () => {
  const out = renderAgentsMd([scoped, always], "agent-rules");

  it("starts with the generated marker and inlines always rules", () => {
    expect(out.startsWith(`<!-- ${GENERATED_MARKER}`)).toBe(true);
    expect(out).toContain("Never delete.");
  });

  it("lists scoped rules in an index instead of inlining them", () => {
    expect(out).not.toContain("Read only.");
    expect(out).toContain("`agent-rules/scoped/database.md`");
    expect(out).toContain("`**/*.sql`, `**/migrations/**`");
    expect(out).toContain("DB \\| files");
  });

  it("ends with a single newline and is deterministic", () => {
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    expect(renderAgentsMd([always, scoped], "agent-rules")).toBe(out);
  });

  it("omits the scoped section when there are none", () => {
    expect(renderAgentsMd([always], "agent-rules")).not.toContain("# Scoped rules");
  });
});

describe("renderClaudeMd", () => {
  it("imports AGENTS.md", () => {
    const out = renderClaudeMd("agent-rules");
    expect(out).toContain("@AGENTS.md");
    expect(out).toContain(GENERATED_MARKER);
  });
});

describe("renderGeminiMd", () => {
  it("points at AGENTS.md instead of repeating the rules", () => {
    const out = renderGeminiMd("agent-rules");
    expect(out).toContain(GENERATED_MARKER);
    expect(out).toContain("@AGENTS.md");
    expect(out).not.toContain("Never delete.");
  });
});

describe("renderAgentRule", () => {
  describe("Cursor (.mdc)", () => {
    it("always rules: alwaysApply true and nothing that could conflict with it", () => {
      const out = renderAgentRule(always, "cursor");
      expect(out).toMatch(/^---\ndescription: Stay safe\nalwaysApply: true\n---\n/);
      expect(out).not.toContain("globs");
      expect(out).not.toContain("trigger");
    });

    it("scoped rules: ONE comma-separated globs string, alwaysApply false, no description", () => {
      const out = renderAgentRule(scoped, "cursor");
      expect(out).toMatch(/^---\nglobs: ["']?\*\*\/\*\.sql, \*\*\/migrations\/\*\*["']?\nalwaysApply: false\n---\n/);
      expect(out).not.toContain("description:");
      expect(out).not.toContain("paths");
    });
  });

  describe("Antigravity (.agents/rules)", () => {
    it("always rules use trigger: always_on", () => {
      expect(renderAgentRule(always, "antigravity")).toMatch(/^---\ntrigger: always_on\ndescription: Stay safe\n---\n/);
    });

    it("scoped rules use trigger: glob with a quoted comma-separated globs string", () => {
      const out = renderAgentRule(scoped, "antigravity");
      expect(out).toContain("trigger: glob");
      expect(out).toContain('globs: "**/*.sql, **/migrations/**"');
      expect(out).toContain("description:");
      expect(out).not.toContain("alwaysApply");
    });
  });

  describe("Qoder (.qoder/rules)", () => {
    it("always rules use trigger: always_on", () => {
      expect(renderAgentRule(always, "qoder")).toMatch(/^---\ntrigger: always_on\ndescription: Stay safe\n---\n/);
    });

    it("scoped rules use trigger: glob with a YAML list under glob", () => {
      const out = renderAgentRule(scoped, "qoder");
      expect(out).toContain("trigger: glob");
      expect(out).toMatch(/glob:\n {2}- "\*\*\/\*\.sql"\n {2}- "\*\*\/migrations\/\*\*"\n/);
      expect(out).not.toContain("globs");
    });
  });

  it("keeps the generated marker and the body, and parses back as valid YAML frontmatter", () => {
    for (const target of ["cursor", "antigravity", "qoder"] as const) {
      for (const rule of [always, scoped]) {
        const out = renderAgentRule(rule, target);
        expect(out).toContain(GENERATED_MARKER);
        expect(out).toContain(rule.body);
        const block = /^---\n([\s\S]*?)\n---\n/.exec(out)?.[1] ?? "";
        expect(() => parseYaml(block), `${target}/${rule.name}`).not.toThrow();
        expect(block).not.toMatch(/[&*]a\d/); // no YAML anchors or aliases
      }
    }
  });
});
