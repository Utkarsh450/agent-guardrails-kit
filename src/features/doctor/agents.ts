import { AGENT_LABELS, type AgentId } from "../../shared/agents.ts";
import type { ReadExisting } from "../../shared/fs-plan.ts";
import { ANTIGRAVITY_USER_SETTINGS, CLAUDE_SETTINGS, CODEX_HOOKS, CURSOR_HOOKS, ENFORCEMENT, QODER_SETTINGS, commands, matchers } from "../agents/index.ts";
import { antigravityPermissions } from "../agents/constants.ts";
import { flatHooks, groupedHooks, readJsonObject, type FoundHook } from "./json-hooks.ts";
import type { Check } from "./types.ts";

const area = "Agents";

/** Compares the hook commands found with the ones the kit writes now. */
function judgeGrouped(agent: AgentId, file: string, found: FoundHook[], expected: string, expectedMatchers: readonly string[]): Check {
  const label = AGENT_LABELS[agent];
  const id = `agent.${agent}`;
  if (found.length === 0) {
    return { id, area, title: `${label}: guard hook`, status: "fail", detail: `${file} has no agent-guardrails hook, so nothing blocks ${label}.`, fix: "agent-guardrails init" };
  }
  if (found.some((hook) => hook.command !== expected)) {
    return { id, area, title: `${label}: guard hook`, status: "warn", detail: `${file} has an older or edited hook command.`, fix: "agent-guardrails update" };
  }
  const covered = new Set(found.map((hook) => hook.matcher));
  const missing = expectedMatchers.filter((m) => !covered.has(m));
  if (missing.length > 0) {
    return { id, area, title: `${label}: guard hook`, status: "warn", detail: `${file} does not cover every tool (missing: ${missing.join(" and ")}).`, fix: "agent-guardrails update" };
  }
  return { id, area, title: `${label}: guard hook`, status: "ok", detail: `${file} runs the guard before tool calls.` };
}

async function claudeLike(
  read: ReadExisting,
  agent: "claude" | "qoder",
  file: string,
  expected: string,
  expectedMatchers: readonly string[],
): Promise<Check[]> {
  const label = AGENT_LABELS[agent];
  const json = await readJsonObject(read, file);
  if (json.state === "missing") return [{ id: `agent.${agent}`, area, title: `${label}: guard hook`, status: "fail", detail: `${file} does not exist.`, fix: "agent-guardrails init" }];
  if (json.state === "invalid") return [{ id: `agent.${agent}`, area, title: `${label}: guard hook`, status: "fail", detail: `${file} ${json.error}.`, fix: "Fix the file by hand (no comments or trailing commas), then run agent-guardrails init" }];

  const checks = [judgeGrouped(agent, file, groupedHooks(json.data, "PreToolUse"), expected, expectedMatchers)];
  if (json.data.disableAllHooks === true) {
    checks.push({ id: `agent.${agent}.hooks-disabled`, area, title: `${label}: hooks switched off`, status: "fail", detail: `${file} sets disableAllHooks, so the guard never runs.`, fix: "Remove disableAllHooks" });
  }
  const permissions = json.data.permissions;
  const deny = typeof permissions === "object" && permissions !== null && Array.isArray((permissions as { deny?: unknown }).deny) ? ((permissions as { deny: unknown[] }).deny as unknown[]) : [];
  if (deny.length === 0) {
    checks.push({ id: `agent.${agent}.deny`, area, title: `${label}: deny rules`, status: "warn", detail: `${file} has no permission deny rules (a second layer that works even if the hook fails).`, fix: "agent-guardrails update" });
  }
  return checks;
}

export async function agentChecks(
  agent: AgentId,
  read: ReadExisting,
  options: { antigravityUserSettings?: string | null } = {},
): Promise<Check[]> {
  const label = AGENT_LABELS[agent];
  switch (agent) {
    case "claude":
      return claudeLike(read, "claude", CLAUDE_SETTINGS, commands.claude, [matchers.claude, matchers.claudeMcp]);
    case "qoder":
      return claudeLike(read, "qoder", QODER_SETTINGS, commands.qoder, [matchers.qoder, matchers.qoderMcp]);

    case "cursor": {
      const json = await readJsonObject(read, CURSOR_HOOKS);
      if (json.state !== "ok") {
        return [{ id: "agent.cursor", area, title: "Cursor: guard hook", status: "fail", detail: json.state === "missing" ? `${CURSOR_HOOKS} does not exist.` : `${CURSOR_HOOKS} ${json.error}.`, fix: "agent-guardrails init" }];
      }
      const shell = flatHooks(json.data, "beforeShellExecution");
      const tools = flatHooks(json.data, "preToolUse");
      if (shell.length === 0 || tools.length === 0) {
        return [{ id: "agent.cursor", area, title: "Cursor: guard hook", status: "fail", detail: `${CURSOR_HOOKS} is missing the guard for ${shell.length === 0 ? "shell commands" : "tool calls"}.`, fix: "agent-guardrails init" }];
      }
      const checks: Check[] = [];
      if ([...shell, ...tools].some((hook) => hook.command !== commands.cursor)) {
        checks.push({ id: "agent.cursor", area, title: "Cursor: guard hook", status: "warn", detail: `${CURSOR_HOOKS} has an older or edited hook command.`, fix: "agent-guardrails update" });
      } else {
        checks.push({ id: "agent.cursor", area, title: "Cursor: guard hook", status: "ok", detail: `${CURSOR_HOOKS} runs the guard for shell commands and tool calls.` });
      }
      if ([...shell, ...tools].some((hook) => hook.failClosed !== true)) {
        checks.push({ id: "agent.cursor.fail-closed", area, title: "Cursor: fails closed", status: "fail", detail: "A hook is missing failClosed: true, so if the guard breaks Cursor lets everything through.", fix: "agent-guardrails update" });
      }
      return checks;
    }

    case "codex": {
      const json = await readJsonObject(read, CODEX_HOOKS);
      if (json.state !== "ok") {
        return [{ id: "agent.codex", area, title: "Codex: guard hook", status: "fail", detail: json.state === "missing" ? `${CODEX_HOOKS} does not exist.` : `${CODEX_HOOKS} ${json.error}.`, fix: "agent-guardrails init" }];
      }
      return [
        judgeGrouped("codex", CODEX_HOOKS, groupedHooks(json.data, "PreToolUse"), commands.codex, [matchers.codex]),
        { id: "agent.codex.trust", area, title: "Codex: hook trust", status: "info", detail: "Codex only runs project hooks you have trusted. This cannot be checked from here.", fix: "Open Codex in this project and run /hooks" },
      ];
    }

    case "antigravity": {
      const checks: Check[] = [{ id: "agent.antigravity", area, title: "Antigravity: advisory only", status: "info", detail: "Antigravity has no hooks. Nothing here can block an action; the rules are only instructions." }];
      const text = options.antigravityUserSettings;
      if (text === undefined || text === null) {
        checks.push({ id: "agent.antigravity.permissions", area, title: "Antigravity: permission rules", status: "info", detail: `Not checked. They live in ${ANTIGRAVITY_USER_SETTINGS}.`, fix: "agent-guardrails doctor --check-user-settings" });
      } else {
        try {
          const settings = JSON.parse(text) as { permissions?: { deny?: unknown } };
          const deny = Array.isArray(settings.permissions?.deny) ? (settings.permissions?.deny as unknown[]) : [];
          const wanted = antigravityPermissions.permissions.deny;
          const missing = wanted.filter((rule) => !deny.includes(rule));
          checks.push(
            missing.length === 0
              ? { id: "agent.antigravity.permissions", area, title: "Antigravity: permission rules", status: "ok", detail: `All ${wanted.length} suggested deny rules are in ${ANTIGRAVITY_USER_SETTINGS}.` }
              : { id: "agent.antigravity.permissions", area, title: "Antigravity: permission rules", status: "warn", detail: `${missing.length} of ${wanted.length} suggested deny rules are missing from ${ANTIGRAVITY_USER_SETTINGS}.`, fix: "agent-guardrails explain antigravity" },
          );
        } catch {
          checks.push({ id: "agent.antigravity.permissions", area, title: "Antigravity: permission rules", status: "warn", detail: `${ANTIGRAVITY_USER_SETTINGS} is not valid JSON.` });
        }
      }
      return checks;
    }
  }
  return [{ id: `agent.${label}`, area, title: label, status: "info", detail: `${ENFORCEMENT[agent]}` }];
}
