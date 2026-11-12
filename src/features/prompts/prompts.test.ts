import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../shared/agents.ts";
import { decide, ROOT, shell } from "../../../tests/helpers/guard-ctx.ts";
import { PROBES, expectedFor, gapReviewPrompt, testGuardrailsPrompt, type Expected, type Probe } from "./index.ts";

/** What the real guard does with a probe under the default settings (Claude Code's view). */
function actual(probe: Probe): Expected {
  if (probe.kind === "shell") {
    const result = shell(probe.command ?? "");
    return result.decision === "deny" ? "blocked" : result.decision === "ask" ? "asked" : "allowed";
  }
  if (probe.kind === "write") {
    const result = decide({ tool_name: "Write", tool_input: { file_path: `${ROOT}/${probe.path}`, content: "guardrail-test" }, cwd: ROOT });
    return result.decision === "deny" ? "blocked" : result.decision === "ask" ? "asked" : "allowed";
  }
  return "refused";
}

describe("the red-team probes match the real guard", () => {
  it.each(PROBES.filter((p) => p.kind !== "manual").map((p) => [p.id, p.command ?? p.path, p] as const))("probe %s (%s)", (_id, _what, probe) => {
    expect(actual(probe)).toBe(probe.expected);
  });

  it("has unique ids in order, and covers every area that matters", () => {
    expect(PROBES.map((p) => p.id)).toEqual(PROBES.map((_, i) => i + 1));
    const groups = new Set(PROBES.map((p) => p.group));
    for (const needed of ["Deleting files", "Git", "GitHub", "Outside the project", "Secrets", "Database", "Piped or downloaded code", "Packages and publishing", "Processes and privileges", "Guardrail files"]) {
      expect(groups, needed).toContain(needed);
    }
    expect(PROBES.some((p) => p.expected === "allowed")).toBe(true);
    expect(PROBES.some((p) => p.expected === "asked")).toBe(true);
    expect(PROBES.some((p) => p.kind === "manual")).toBe(true);
  });

  it("every probe is harmless if it somehow ran: nothing real is deleted, published, killed or elevated", () => {
    const commands = PROBES.filter((p) => p.kind === "shell").map((p) => p.command ?? "");
    expect(commands).toContain("npm publish --dry-run");
    expect(commands).toContain("kill -0 1");
    expect(commands).toContain("sudo -n true");
    for (const command of commands) {
      expect(command).not.toMatch(/\brm -rf\b/);
      expect(command).not.toMatch(/npm publish(?! --dry-run)/);
      expect(command).not.toMatch(/\bkill -9\b/);
      expect(command).not.toMatch(/git push (-f|--force)/);
    }
  });

  it("maps asks to blocks for Codex only", () => {
    const asked = PROBES.find((p) => p.expected === "asked")!;
    expect(expectedFor(asked, "codex")).toBe("blocked");
    expect(expectedFor(asked, "claude")).toBe("asked");
    expect(expectedFor(asked, undefined)).toBe("asked");
    const blocked = PROBES.find((p) => p.expected === "blocked")!;
    expect(expectedFor(blocked, "codex")).toBe("blocked");
  });
});

describe("testGuardrailsPrompt", () => {
  const prompt = testGuardrailsPrompt("claude");

  it("lists every probe with its expectation", () => {
    for (const probe of PROBES) expect(prompt).toContain(`${probe.id}. `);
    expect(prompt).toContain("Run: `rm guardrail-test-file.txt`  (expect BLOCKED)");
    expect(prompt).toContain("Run: `git status`  (expect ALLOWED)");
    expect(prompt).toContain("(expect ASKED)");
    expect(prompt).toContain("(expect REFUSED)");
  });

  it("insists on a disposable copy, a stop rule and a report", () => {
    expect(prompt).toMatch(/disposable copy/);
    expect(prompt).toMatch(/no git remotes/);
    expect(prompt).toMatch(/STOP IMMEDIATELY/);
    expect(prompt).toMatch(/GUARDRAIL FAILURE/);
    expect(prompt).toMatch(/never try to get around a block/i);
    expect(prompt).toMatch(/Never use `--no-verify`/);
    expect(prompt).toContain("| # | Probe | Expected |");
    expect(prompt).toMatch(/"PASS"/);
  });

  it("tells Codex that asks are blocks, and warns advisory agents that probes may run", () => {
    const codex = testGuardrailsPrompt("codex");
    expect(codex).toMatch(/cannot ask me questions/);
    expect(codex).not.toContain("(expect ASKED)");
    expect(codex).toContain("python3 guardrail-test.py`  (expect BLOCKED)");
    const antigravity = testGuardrailsPrompt("antigravity");
    expect(antigravity).toMatch(/no hooks/);
    expect(antigravity).toMatch(/may be ALLOWED/);
  });

  it("works for every agent and without one", () => {
    for (const agent of [...AGENT_IDS, undefined]) expect(testGuardrailsPrompt(agent).length).toBeGreaterThan(1500);
  });
});

describe("gapReviewPrompt", () => {
  it("is read only, asks the right questions and embeds the doctor output when given", () => {
    const prompt = gapReviewPrompt("[FAIL] guard");
    expect(prompt).toMatch(/Change nothing/);
    expect(prompt).toMatch(/Which of the agents used here are only advisory/);
    expect(prompt).toMatch(/never values/);
    expect(prompt).toContain("```\n[FAIL] guard\n```");
    expect(gapReviewPrompt()).toMatch(/Run `agent-guardrails-kit doctor` yourself/);
  });
});
