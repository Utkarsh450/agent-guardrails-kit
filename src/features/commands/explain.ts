import { explain, listExplainable, suggestFor } from "../explain/index.ts";
import { CliError } from "./errors.ts";
import type { CommandContext } from "./context.ts";

/** `agent-guardrails explain [name]`: why the guard did something, in plain words. */
export function runExplain(ctx: CommandContext, name?: string): number {
  const { ui } = ctx;
  if (name === undefined || name.trim() === "") {
    const all = listExplainable();
    ui.print("Ask about any of these: agent-guardrails explain <name>\n");
    ui.print(`Topics: ${all.topics.join(", ")}`);
    ui.print(`Agents: ${all.agents.join(", ")}`);
    ui.print(`Reasons the guard gives (shown in blocked messages and in \`report\`):\n  ${all.rules.join(", ")}`);
    return 0;
  }
  const found = explain(name);
  if (found === null) {
    const close = suggestFor(name);
    throw new CliError(`Nothing to explain called "${name}".${close.length > 0 ? ` Did you mean: ${close.join(", ")}?` : ""} Run \`agent-guardrails explain\` to see everything.`);
  }
  ui.print(found.title);
  ui.print("");
  for (const line of found.lines) ui.print(line === "" ? "" : `  ${line}`);
  return 0;
}
