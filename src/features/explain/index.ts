import { AGENT_IDS, AGENT_LABELS, isAgentId } from "../../shared/agents.ts";
import { branchProtectionCommand } from "../github/index.ts";
import { ENFORCEMENT, antigravityPermissionsSnippet, ANTIGRAVITY_USER_SETTINGS } from "../agents/index.ts";
import { HOOKS_PATH_COMMAND } from "../git/index.ts";
import { PRESETS, PRESET_SUMMARY, STACKS, STACK_SUMMARY } from "../presets/index.ts";
import { RULES, ruleInfo, type Kind } from "./catalog.ts";

export { RULES, ruleInfo, type Kind, type RuleInfo } from "./catalog.ts";

export interface Explanation {
  title: string;
  lines: string[];
}

const KIND_TEXT: Record<Kind, string> = { blocked: "The guard blocks this.", asks: "The guard asks you first.", info: "" };

/** Topics beyond individual rules. */
const TOPICS: Record<string, () => Explanation> = {
  agents: () => ({
    title: "Which agents are really protected",
    lines: AGENT_IDS.map((id) => `${AGENT_LABELS[id]}: ${ENFORCEMENT[id] === "enforced" ? "enforced. A hook checks every action and can block it." : "advisory. It has no hooks, so the rules are only instructions it is asked to follow."}`),
  }),
  presets: () => ({
    title: "Presets and stacks",
    lines: [
      ...PRESETS.map((p) => `${p}: ${PRESET_SUMMARY[p]}`),
      "",
      "Every preset keeps the dangerous-command blocks, asks about unknown commands, and needs an approved plan before files change.",
      "",
      ...STACKS.map((s) => `${s}: ${STACK_SUMMARY[s]}`),
    ],
  }),
  approval: () => ({
    title: "Plan approval",
    lines: [
      "Agents cannot create or change files until you approve a plan.",
      "1. Ask the agent to write its plan to PLAN.md (it is allowed to write that file).",
      "2. Read it, then run: agent-guardrails-kit approve",
      "3. The agent can now work. If PLAN.md changes afterwards, the approval is cancelled and you approve again.",
      "Turn it off with \"approvalGate\": false in agent-guardrails.config.json (not recommended).",
    ],
  }),
  allow: () => ({
    title: "Letting commands run without asking",
    lines: [
      "By default the guard asks about commands it does not recognise. To stop asking about one you trust:",
      "  agent-guardrails-kit allow add \"pnpm test\"",
      "The entry matches commands that START with those words, with any arguments after them. Hard blocks (rm, git push, gh, publishing...) can never be allowed this way.",
      "See the list with `agent-guardrails-kit allow list`.",
    ],
  }),
  git: () => ({
    title: "Git hooks and what agents may do with git",
    lines: [
      "Agents may only run read-only git commands: status, diff, log and show (the team preset adds a few more).",
      "Hooks in .githooks check every commit and push, whichever tool made it: secrets, risky dependencies and force pushes are stopped.",
      `Git only uses them after one setting in each clone: ${HOOKS_PATH_COMMAND}`,
      "Only a person should bypass them (git commit --no-verify). The guard forbids agents from doing so.",
    ],
  }),
  hooks: () => ({
    title: "Fail closed",
    lines: [
      "If the guard cannot run (Node missing, file missing, crash, broken settings), the action is blocked instead of allowed.",
      "That is why a broken setup shows up as everything being blocked. Run `agent-guardrails-kit doctor` to find the cause.",
    ],
  }),
  codex: () => ({
    title: "Codex",
    lines: [
      "Codex hooks can only block or stay silent; they cannot ask you. The guard therefore blocks anything it would normally ask about and tells the agent to ask you in chat.",
      "Codex only runs project hooks you have trusted: open Codex here and run /hooks. Trust is tied to the hook's definition, so re-trust after `agent-guardrails-kit update`.",
      "Recommended in ~/.codex/config.toml or .codex/config.toml (check the key names in the current Codex docs): approval_policy = \"on-request\" and sandbox_mode = \"workspace-write\".",
    ],
  }),
  antigravity: () => ({
    title: "Antigravity",
    lines: [
      "Antigravity has no hooks, so nothing in the project can block an action.",
      `Add rules yourself in ${ANTIGRAVITY_USER_SETTINGS} (the kit never writes outside the project):`,
      ...antigravityPermissionsSnippet().split("\n"),
      "Its command rules match prefixes and stop matching for compound commands, so treat them as a weak layer. Keep Terminal Command Auto Execution on 'Request Review'.",
    ],
  }),
  "branch-protection": () => ({
    title: "Branch protection on GitHub",
    lines: [
      "The one protection that lives on GitHub, not in the project. You run it yourself once; it needs the GitHub CLI (gh). Replace OWNER, REPO and the branch name:",
      ...branchProtectionCommand({ owner: "OWNER", repo: "REPO", branch: "main" }).split("\n"),
      "It blocks force pushes and branch deletion, and requires the 'guardrails' check and one review.",
    ],
  }),
  limits: () => ({
    title: "What the guard cannot do",
    lines: [
      "It reads the command text. It cannot see what a script file does, and a determined agent can find ways around any pattern list.",
      "Paths handed over through pipes (find | xargs cat) are not checked.",
      "Antigravity has no hooks. MCP tools can only be judged by name.",
      "Use it as one layer next to git hooks, branch protection, the agents' own permission settings, sandboxing and not keeping production credentials on your machine.",
    ],
  }),
};

export function topicNames(): string[] {
  return Object.keys(TOPICS);
}

function describeRule(id: string): Explanation | null {
  const info = ruleInfo(id);
  if (!info) return null;
  return {
    title: `${id}: ${info.title}`,
    lines: [...(KIND_TEXT[info.kind] ? [KIND_TEXT[info.kind]] : []), `Why: ${info.why}`, `What to do: ${info.instead}`],
  };
}

function suggestions(query: string): string[] {
  const q = query.toLowerCase();
  const all = [...Object.keys(RULES), ...topicNames(), ...AGENT_IDS];
  const close = all.filter((name) => name.includes(q) || q.includes(name));
  return close.length > 0 ? close : all.filter((name) => name[0] === q[0]).slice(0, 5);
}

/** Explains a rule id, a topic or an agent in plain words. Returns null when it does not know the name. */
export function explain(name: string): Explanation | null {
  const key = name.trim().toLowerCase();
  const rule = describeRule(key);
  if (rule) return rule;
  const topic = TOPICS[key];
  if (topic) return topic();
  if (isAgentId(key)) {
    const label = AGENT_LABELS[key];
    const extra = key === "codex" ? TOPICS.codex!() : key === "antigravity" ? TOPICS.antigravity!() : null;
    return {
      title: label,
      lines: [ENFORCEMENT[key] === "enforced" ? `${label} is enforced: a hook checks every action.` : `${label} is advisory only: it has no hooks.`, ...(extra ? ["", ...extra.lines] : [])],
    };
  }
  return null;
}

export function suggestFor(name: string): string[] {
  return suggestions(name);
}

/** Everything `explain` knows, for the listing. */
export function listExplainable(): { rules: string[]; topics: string[]; agents: string[] } {
  return { rules: Object.keys(RULES).sort(), topics: topicNames(), agents: [...AGENT_IDS] };
}
