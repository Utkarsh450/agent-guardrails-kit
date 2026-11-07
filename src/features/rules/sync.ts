import { readdir } from "node:fs/promises";
import path from "node:path";
import type { AgentId } from "../../shared/agents.ts";
import {
  applyPlan,
  diskReadExisting,
  isGenerated,
  planFiles,
  type DesiredFile,
  type PlannedFile,
  type ReadExisting,
} from "../../shared/fs-plan.ts";
import { parseRule } from "./parse.ts";
import { renderAgentRule, renderAgentsMd, renderClaudeMd, renderGeminiMd, type RuleTarget } from "./render.ts";
import { DEFAULT_RULES_DIR, RuleError, type Rule, type RuleScope } from "./types.ts";

/** The only file system access sync needs. Tests pass an in-memory version. */
export interface SyncIo {
  readExisting: ReadExisting;
  /** File names (not paths) inside a project-relative directory; [] when the directory is missing. */
  listFiles(relDir: string): Promise<string[]>;
}

export interface SyncOptions {
  agents: readonly AgentId[];
  /** Directory holding the rule sources, relative to the project root. */
  rulesDir?: string;
  /**
   * Also write the always-on rules as per-agent files. Off by default: Cursor, Antigravity and Qoder all read
   * AGENTS.md themselves, so repeating the always-on rules there only doubles the context they use.
   */
  alwaysRuleFiles?: boolean;
}

export interface SyncPlan {
  rules: Rule[];
  files: PlannedFile[];
  /** Generated files in agent rule folders whose source rule no longer exists. Reported, never deleted. */
  stale: string[];
  /** Problems worth showing the user (for example, a hub file that is too large for an agent). */
  warnings: string[];
}

/** Antigravity truncates any single rule file larger than this many bytes. */
export const ANTIGRAVITY_MAX_FILE_BYTES = 24_000;

/** Where each agent's per-rule files go, which extension they use and how they are rendered. */
const AGENT_RULE_DIRS: Partial<Record<AgentId, { dir: string; ext: string; target: RuleTarget }>> = {
  cursor: { dir: ".cursor/rules", ext: ".mdc", target: "cursor" },
  antigravity: { dir: ".agents/rules", ext: ".md", target: "antigravity" },
  qoder: { dir: ".qoder/rules", ext: ".md", target: "qoder" },
};

export function diskSyncIo(root: string): SyncIo {
  return {
    readExisting: diskReadExisting(root),
    async listFiles(relDir) {
      try {
        const entries = await readdir(path.join(root, ...relDir.split("/")), {
          withFileTypes: true,
        });
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort();
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return [];
        throw error;
      }
    },
  };
}

async function loadScope(
  io: SyncIo,
  rulesDir: string,
  scope: RuleScope,
): Promise<Rule[]> {
  const dir = `${rulesDir}/${scope}`;
  const names = (await io.listFiles(dir)).filter((file) => file.endsWith(".md"));
  const rules: Rule[] = [];
  for (const file of names) {
    const sourcePath = `${dir}/${file}`;
    const existing = await io.readExisting(sourcePath);
    if (existing === null || existing.kind !== "file") {
      throw new RuleError(`${sourcePath}: expected a regular file.`);
    }
    rules.push(
      parseRule({ sourcePath, scope, name: file.slice(0, -".md".length), raw: existing.content }),
    );
  }
  return rules;
}

export async function loadRules(io: SyncIo, rulesDir: string): Promise<Rule[]> {
  const always = await loadScope(io, rulesDir, "always");
  const scoped = await loadScope(io, rulesDir, "scoped");

  if (always.length === 0) {
    throw new RuleError(
      `No rules found in ${rulesDir}/always/. Run \`agent-guardrails init\` first, or add a rule file there.`,
    );
  }

  const seen = new Map<string, string>();
  for (const rule of [...always, ...scoped]) {
    const other = seen.get(rule.name);
    if (other !== undefined) {
      throw new RuleError(
        `Rule name "${rule.name}" is used twice (${other} and ${rule.sourcePath}). Names must be unique across always/ and scoped/.`,
      );
    }
    seen.set(rule.name, rule.sourcePath);
  }

  return [...always, ...scoped];
}

/** Pure: which files should exist for these rules and agents. */
export function desiredFiles(
  rules: readonly Rule[],
  agents: readonly AgentId[],
  rulesDir: string = DEFAULT_RULES_DIR,
  alwaysRuleFiles = false,
): DesiredFile[] {
  const agentsMd = renderAgentsMd(rules, rulesDir);
  const files: DesiredFile[] = [{ path: "AGENTS.md", content: agentsMd, generated: true }];

  if (agents.includes("claude")) {
    files.push({ path: "CLAUDE.md", content: renderClaudeMd(rulesDir), generated: true });
  }
  if (agents.includes("antigravity")) {
    files.push({ path: "GEMINI.md", content: renderGeminiMd(rulesDir), generated: true });
  }

  for (const agent of agents) {
    const target = AGENT_RULE_DIRS[agent];
    if (!target) continue;
    for (const rule of rules) {
      if (rule.scope === "always" && !alwaysRuleFiles) continue;
      files.push({
        path: `${target.dir}/${rule.name}${target.ext}`,
        content: renderAgentRule(rule, target.target),
        generated: true,
      });
    }
  }

  return files;
}

async function findStale(
  io: SyncIo,
  agents: readonly AgentId[],
  desired: readonly DesiredFile[],
): Promise<string[]> {
  const wanted = new Set(desired.map((file) => file.path));
  const stale: string[] = [];

  for (const agent of agents) {
    const target = AGENT_RULE_DIRS[agent];
    if (!target) continue;
    for (const file of await io.listFiles(target.dir)) {
      const rel = `${target.dir}/${file}`;
      if (wanted.has(rel)) continue;
      const existing = await io.readExisting(rel);
      if (existing?.kind === "file" && isGenerated(existing.content)) stale.push(rel);
    }
  }

  return stale.sort();
}

/** Reads the rule sources and works out what sync would do. Writes nothing. */
export async function planSync(io: SyncIo, options: SyncOptions): Promise<SyncPlan> {
  const rulesDir = options.rulesDir ?? DEFAULT_RULES_DIR;
  const rules = await loadRules(io, rulesDir);
  const desired = desiredFiles(rules, options.agents, rulesDir, options.alwaysRuleFiles ?? false);
  const files = await planFiles(desired, io.readExisting);
  const stale = await findStale(io, options.agents, desired);

  const warnings: string[] = [];
  const hubBytes = Buffer.byteLength(desired[0]?.content ?? "", "utf8");
  if (options.agents.includes("antigravity") && hubBytes > ANTIGRAVITY_MAX_FILE_BYTES) {
    warnings.push(
      `AGENTS.md is ${hubBytes} bytes. Antigravity truncates rule files over ${ANTIGRAVITY_MAX_FILE_BYTES} bytes, so the end of the rules may be ignored. Move some rules to agent-rules/scoped/.`,
    );
  }
  return { rules, files, stale, warnings };
}

/** Writes the planned creates and updates. Conflicts are left alone. Returns the written paths. */
export function applySync(root: string, plan: SyncPlan): Promise<string[]> {
  return applyPlan(root, plan.files);
}
