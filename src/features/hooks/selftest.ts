import { spawnSync } from "node:child_process";
import {
  evaluate,
  normalizeRequest,
  respond,
  type AgentName,
  type Decision,
  type GuardConfig,
} from "./guard/guard.mjs";
import type { CorpusCase } from "./corpus/types.ts";
import { fileCases } from "./corpus/file-cases.ts";
import { shellCases } from "./corpus/shell-cases.ts";
import { makeContext, SANDBOX_ROOT } from "./sandbox.ts";

/** Every case the self-test knows about. */
export const allCases: readonly CorpusCase[] = [...shellCases, ...fileCases];

export interface CaseResult {
  testCase: CorpusCase;
  /** Short readable label: the command or the tool and path. */
  label: string;
  /** Which run this was: "base" or a stress variant. */
  variant: string;
  got: { decision: Decision["decision"]; rule: string; reason: string };
  ok: boolean;
  problem: string | null;
}

export interface Summary {
  total: number;
  passed: number;
  failed: CaseResult[];
}

function labelOf(testCase: CorpusCase): string {
  if (testCase.command !== undefined) return testCase.command.replaceAll("\n", "\\n");
  const payload = testCase.payload as Record<string, unknown> | null;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const input = (payload.tool_input ?? {}) as Record<string, unknown>;
    const detail = input.command ?? input.file_path ?? payload.command ?? payload.file_path ?? "";
    return `${String(payload.tool_name ?? "payload")} ${String(detail)}`.replaceAll("\n", "\\n").trim();
  }
  return JSON.stringify(payload);
}

function payloadOf(testCase: CorpusCase, root: string): unknown {
  const raw: unknown =
    testCase.payload !== undefined
      ? testCase.payload
      : { tool_name: "Bash", tool_input: { command: testCase.command }, cwd: "{{ROOT}}" };
  return JSON.parse(JSON.stringify(raw === undefined ? null : raw).replaceAll("{{ROOT}}", JSON.stringify(root).slice(1, -1)));
}

/** Compares what the guard did with what the case demands. Returns a problem message or null. */
export function checkExpectation(testCase: CorpusCase, got: Pick<Decision, "decision" | "rule">): string | null {
  switch (testCase.expect) {
    case "deny":
      if (got.decision !== "deny") return `expected deny, got ${got.decision} (${got.rule})`;
      if (testCase.rule !== undefined && got.rule !== testCase.rule) return `expected rule ${testCase.rule}, got ${got.rule}`;
      return null;
    case "allow":
      return got.decision === "allow" ? null : `expected allow, got ${got.decision} (${got.rule})`;
    case "gated":
      return got.decision !== "allow" ? null : "expected the guard to ask or deny, but it allowed the action";
    case "not-deny":
      return got.decision !== "deny" ? null : `expected ask or allow, got deny (${got.rule})`;
  }
}

interface Variant {
  name: string;
  config: Partial<GuardConfig>;
}

/**
 * Extra runs for cases that must always be blocked: even a project that allows everything
 * (policy "blocklist" plus an allowCommands entry of "*") must not get past a hard block.
 */
const STRESS_VARIANTS: readonly Variant[] = [
  { name: "policy=blocklist, allowCommands=[*]", config: { policy: "blocklist", allowCommands: ["*"] } },
  { name: "policy=allowlist, allowCommands=[*]", config: { policy: "allowlist", allowCommands: ["*"] } },
];

/** Runs the corpus against the guard code in this process. Fast; uses an in-memory project. */
export function runCorpusInProcess(cases: readonly CorpusCase[] = allCases): CaseResult[] {
  const results: CaseResult[] = [];

  const runOne = (testCase: CorpusCase, variant: Variant | null): void => {
    const files: Record<string, string> = {};
    for (const [rel, content] of Object.entries(testCase.files ?? {})) files[`${SANDBOX_ROOT}/${rel}`] = content;
    const ctx = makeContext({
      files,
      approved: testCase.approved ?? false,
      config: { ...testCase.config, ...variant?.config },
    });
    const decision = evaluate(normalizeRequest(payloadOf(testCase, SANDBOX_ROOT)), ctx);
    const problem = checkExpectation(testCase, decision);
    results.push({
      testCase,
      label: labelOf(testCase),
      variant: variant?.name ?? "base",
      got: { decision: decision.decision, rule: decision.rule, reason: decision.reason },
      ok: problem === null,
      problem,
    });
  };

  for (const testCase of cases) {
    runOne(testCase, null);
    const wantsStress = testCase.expect === "deny" || testCase.stress === true;
    if (wantsStress && testCase.command !== undefined && testCase.config === undefined) {
      for (const variant of STRESS_VARIANTS) runOne(testCase, variant);
    }
  }
  return results;
}

/** True when a case can run against a real guard script in a real folder (no fixtures needed). */
export function isStateless(testCase: CorpusCase): boolean {
  return testCase.approved === undefined && testCase.config === undefined && testCase.files === undefined;
}

export interface SpawnOptions {
  /** Path to the installed guard.mjs. */
  guardPath: string;
  /** Project root the guard should treat as the project (passed as --root). */
  root: string;
  agent?: AgentName;
  /** Node binary to run the guard with. */
  node?: string;
  cases?: readonly CorpusCase[];
}

/**
 * Runs stateless corpus cases by starting the real guard script once per case, exactly as an agent would.
 * Slow (one process per case) but proves the installed file works end to end, including exit codes.
 */
export function runCorpusSpawned(options: SpawnOptions): CaseResult[] {
  const agent = options.agent ?? "claude";
  const results: CaseResult[] = [];
  for (const testCase of options.cases ?? allCases.filter(isStateless)) {
    if (!isStateless(testCase)) continue;
    const input = JSON.stringify(payloadOf(testCase, options.root));
    const run = spawnSync(options.node ?? process.execPath, [options.guardPath, "--agent", agent, "--root", options.root], {
      input,
      encoding: "utf8",
      env: { ...process.env, AGENT_GUARDRAILS_NO_AUDIT: "1" },
    });
    const got = interpretProcess(agent, run.status, run.stdout ?? "", run.stderr ?? "");
    const problem = checkExpectation(testCase, got);
    results.push({
      testCase,
      label: labelOf(testCase),
      variant: `spawned (${agent})`,
      got: { decision: got.decision, rule: got.rule, reason: got.reason },
      ok: problem === null,
      problem,
    });
  }
  return results;
}

/** Reads a guard process's output the way an agent would. */
export function interpretProcess(
  agent: AgentName,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): { decision: Decision["decision"]; rule: string; reason: string } {
  if (exitCode === 2) {
    const match = /\(([a-z-]+)\):/.exec(stderr || stdout);
    return { decision: "deny", rule: match?.[1] ?? "unknown", reason: (stderr || stdout).trim() };
  }
  if (exitCode !== 0) return { decision: "deny", rule: "crash", reason: `exit code ${String(exitCode)}: ${stderr.trim()}` };
  const text = stdout.trim();
  if (text === "") return { decision: "allow", rule: "allowed", reason: "" };
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const hook = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
    const verdict = (hook.permissionDecision ?? json.permission) as string | undefined;
    if (verdict === "ask") return { decision: "ask", rule: "ask", reason: String(hook.permissionDecisionReason ?? json.user_message ?? "") };
    if (verdict === "deny") return { decision: "deny", rule: "deny", reason: String(json.user_message ?? "") };
    if (verdict === "allow") return { decision: "allow", rule: "allowed", reason: "" };
  } catch {
    // fall through
  }
  return { decision: "deny", rule: "unreadable-output", reason: `${agent} output was not understood: ${text.slice(0, 120)}` };
}

export function summarize(results: readonly CaseResult[]): Summary {
  const failed = results.filter((r) => !r.ok);
  return { total: results.length, passed: results.length - failed.length, failed };
}

/** Human-readable failure report for the CLI and for test output. */
export function formatFailures(summary: Summary, limit = 25): string {
  if (summary.failed.length === 0) return `All ${summary.total} checks passed.`;
  const lines = summary.failed.slice(0, limit).map((r) => `  [${r.variant}] ${r.label}\n      ${r.problem ?? ""}`);
  const more = summary.failed.length > limit ? `\n  ... and ${summary.failed.length - limit} more` : "";
  return `${summary.failed.length} of ${summary.total} checks failed:\n${lines.join("\n")}${more}`;
}

// Keep respond() reachable from here so the CLI can show how each agent would be answered.
export { respond };
