import type { AgentId } from "../../shared/agents.ts";
import type { ReadExisting } from "../../shared/fs-plan.ts";

/** Files and folders that show an agent is used in a project. AGENTS.md alone is shared by several agents. */
const EVIDENCE: Record<AgentId, readonly string[]> = {
  claude: [".claude", "CLAUDE.md"],
  cursor: [".cursor", ".cursorrules"],
  codex: [".codex"],
  antigravity: [".agents", ".agent", "GEMINI.md"],
  qoder: [".qoder"],
};

export interface Detected {
  agent: AgentId;
  /** What was found, for showing the user why the agent was suggested. */
  evidence: string[];
}

/** Looks for each agent's footprint in the project. Reads only; never writes. */
export async function detectAgents(read: ReadExisting): Promise<Detected[]> {
  const found: Detected[] = [];
  for (const [agent, paths] of Object.entries(EVIDENCE) as Array<[AgentId, readonly string[]]>) {
    const evidence: string[] = [];
    for (const rel of paths) {
      if ((await read(rel)) !== null) evidence.push(rel);
    }
    if (evidence.length > 0) found.push({ agent, evidence });
  }
  return found;
}
