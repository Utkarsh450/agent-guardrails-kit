import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RuleError, type Rule, type RuleScope } from "./types.ts";

const frontmatterSchema = z.object({
  description: z.string().trim().min(1, "description must not be empty"),
  globs: z.array(z.string().trim().min(1)).optional(),
});

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

export interface ParseRuleInput {
  /** Source path relative to the project root; used only in error messages and output. */
  sourcePath: string;
  scope: RuleScope;
  name: string;
  raw: string;
}

/** Parses one rule source file (YAML frontmatter + markdown body). Throws RuleError with a clear message. */
export function parseRule({ sourcePath, scope, name, raw }: ParseRuleInput): Rule {
  const text = raw.replace(/^﻿/, "").replaceAll("\r\n", "\n");
  const match = FRONTMATTER.exec(text);
  if (!match) {
    throw new RuleError(
      `${sourcePath}: missing frontmatter. Start the file with a "---" block that has a description.`,
    );
  }

  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuleError(`${sourcePath}: frontmatter is not valid YAML (${detail})`);
  }

  const result = frontmatterSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "frontmatter"}: ${issue.message}`)
      .join("; ");
    throw new RuleError(`${sourcePath}: invalid frontmatter (${issues})`);
  }

  const globs = result.data.globs ?? [];
  if (scope === "scoped" && globs.length === 0) {
    throw new RuleError(`${sourcePath}: scoped rules need at least one entry in "globs".`);
  }

  const body = text.slice(match[0].length).trim();
  if (body === "") {
    throw new RuleError(`${sourcePath}: the rule has no content after the frontmatter.`);
  }

  return {
    name,
    scope,
    description: result.data.description,
    globs: scope === "scoped" ? globs : [],
    body,
    sourcePath,
  };
}
