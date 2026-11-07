import { evaluate, normalizeRequest } from "../hooks/guard/guard.mjs";
import { makeContext } from "../hooks/sandbox.ts";
import { BROAD_PROGRAMS } from "../presets/index.ts";

export interface AllowProblem {
  entry: string;
  reason: string;
}

/**
 * The checks `allow add` applies to one command, run over every `allowCommands` entry of a preset:
 * it must start with a command name, must not be a bare program that runs any script, and must not be something
 * the guard blocks or asks about whatever the allow list says.
 */
export function checkAllowCommands(entries: readonly string[]): AllowProblem[] {
  const problems: AllowProblem[] = [];
  for (const raw of entries) {
    const entry = raw.trim().split(/\s+/).join(" ");
    const words = entry.split(" ");
    const first = words[0] ?? "";
    if (first === "*") {
      problems.push({ entry, reason: 'starts with "*", which would allow every command' });
      continue;
    }
    if (words.length === 1 && BROAD_PROGRAMS.has(first)) {
      problems.push({ entry, reason: `lets an agent run any ${first} script without asking; name the script, for example "${first} scripts/build.mjs"` });
      continue;
    }
    const probe = makeContext({ config: { allowCommands: [entry] } });
    const result = evaluate(normalizeRequest({ tool_name: "Bash", tool_input: { command: entry }, cwd: "/proj" }), probe);
    if (result.decision === "deny") problems.push({ entry, reason: `is always blocked (${result.rule}), so allowing it would do nothing` });
    else if (result.decision === "ask") problems.push({ entry, reason: `would still ask (${result.rule}), so it cannot be allowed in advance` });
  }
  return problems;
}
