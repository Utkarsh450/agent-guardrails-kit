import { stat } from "node:fs/promises";
import path from "node:path";
import { isAgentId, type AgentId } from "../../shared/agents.ts";
import { GUARD_INSTALL_PATH, allCases, formatFailures, isStateless, runCorpusInProcess, runCorpusSpawned, summarize, type CaseResult } from "../hooks/index.ts";
import { gapReviewPrompt, testGuardrailsPrompt } from "../prompts/index.ts";
import { diskSyncIo } from "../rules/index.ts";
import { loadSavedConfig } from "../setup/index.ts";
import { CliError } from "./errors.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";
import { formatDoctor, gatherDoctor } from "./doctor.ts";

export interface TestOptions {
  /** Run the guard self-test (the default when no other mode is chosen). */
  hooks?: boolean;
  /** Print the red-team prompt to paste into a fresh agent session. */
  prompt?: boolean;
  /** Print the read-only gap-review prompt. */
  gapReview?: boolean;
  /** Which agent the prompt is for. */
  agent?: string;
  /** Run every case against the installed guard instead of a sample (slow). */
  full?: boolean;
}

function chooseAgent(flag: string | undefined, saved: AgentId[]): AgentId | undefined {
  if (flag !== undefined) {
    if (!isAgentId(flag)) throw new CliError(`Unknown agent "${flag}".`);
    return flag;
  }
  return saved[0];
}

const line = (label: string, results: readonly CaseResult[]) => {
  const s = summarize(results);
  return `  ${label}: ${s.passed}/${s.total} passed`;
};

/** `agent-guardrails test`: proves the guard blocks what it should, or prints a prompt to test an agent for real. */
export async function runTest(ctx: CommandContext, options: TestOptions = {}): Promise<number> {
  const { ui } = ctx;
  const root = findProjectRoot(ctx.cwd);
  const io = diskSyncIo(root);
  const saved = await loadSavedConfig(io);

  if (options.prompt || options.gapReview) {
    const agent = chooseAgent(options.agent, saved?.agents ?? []);
    const body = options.gapReview ? gapReviewPrompt(formatDoctor(await gatherDoctor(root))) : testGuardrailsPrompt(agent);
    if (options.prompt) {
      ui.print("How to use this prompt:");
      ui.print("  1. Make a throwaway copy of your project (no git remotes, no real credentials). Never test in your real working copy.");
      ui.print("  2. Open a FRESH session of your AI agent in that copy and paste everything between the lines below.");
      ui.print("  3. Answer NO to every permission question. The agent reports what was blocked, asked or allowed.");
      ui.print("");
    }
    ui.print("----- copy from here -----");
    ui.print(body);
    ui.print("----- to here -----");
    return 0;
  }

  ui.intro("agent-guardrails test");
  const results: CaseResult[] = [];

  const inProcess = runCorpusInProcess();
  results.push(...inProcess);
  ui.print(`This kit's guard against ${allCases.length} known attack and safe cases (${inProcess.length} checks including stress variants):`);
  ui.print(line("in-process", inProcess));

  const guardPath = path.join(root, GUARD_INSTALL_PATH);
  const installed = await stat(guardPath).then(
    () => true,
    () => false,
  );
  if (!installed) {
    ui.error(`${GUARD_INSTALL_PATH} is not installed, so the guard in this project could not be tested. Run \`agent-guardrails init\` first.`);
    const summary = summarize(results);
    if (summary.failed.length > 0) ui.print(formatFailures(summary, 15));
    return 1;
  }

  const step = options.full ? 1 : 7;
  const stateless = allCases.filter(isStateless);
  const claudeCases = stateless.filter((_, index) => index % step === 0);
  const otherCases = stateless.filter((c) => c.expect === "deny" || c.expect === "allow").filter((_, index) => index % (step * 3) === 0);
  ui.info(`Now running the guard installed in this project as a separate process, the way each agent does (${claudeCases.length + otherCases.length * 3} runs${options.full ? "" : "; use --full for every case"}). This takes a few seconds.`);

  ui.print("The guard installed in this project:");
  const perAgent: Array<[string, readonly CaseResult[]]> = [
    ["Claude Code", runCorpusSpawned({ guardPath, root, agent: "claude", cases: claudeCases })],
    ["Cursor", runCorpusSpawned({ guardPath, root, agent: "cursor", cases: otherCases })],
    ["Codex", runCorpusSpawned({ guardPath, root, agent: "codex", cases: otherCases })],
    ["Qoder", runCorpusSpawned({ guardPath, root, agent: "qoder", cases: otherCases })],
  ];
  for (const [label, rows] of perAgent) {
    ui.print(line(label, rows));
    results.push(...rows);
  }

  const summary = summarize(results);
  if (summary.failed.length > 0) {
    ui.print("");
    ui.print(formatFailures(summary, 15));
    ui.error("Some checks failed. If you changed the settings on purpose (for example allowed a command), a failure may be expected; otherwise run `agent-guardrails doctor`.");
    return 1;
  }
  ui.outro("Everything passed. This proves the guard's logic, not your agents: `agent-guardrails test --prompt` gives you a prompt to test an agent for real.");
  return 0;
}
