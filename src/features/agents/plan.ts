import type { AgentId } from "../../shared/agents.ts";
import type { ReadExisting } from "../../shared/fs-plan.ts";
import { planAntigravity } from "./antigravity.ts";
import { planClaude } from "./claude.ts";
import { planCodex } from "./codex.ts";
import { planCursor } from "./cursor.ts";
import { planQoder } from "./qoder.ts";
import type { AgentPlan, Enforcement } from "./types.ts";

/** What each agent can do for you, before anything is planned. */
export const ENFORCEMENT: Record<AgentId, Enforcement> = {
  claude: "enforced",
  cursor: "enforced",
  codex: "enforced",
  qoder: "enforced",
  antigravity: "advisory",
};

/** Plans the hook and permission config for the chosen agents. Writes nothing. */
export async function planAgents(read: ReadExisting, agents: readonly AgentId[]): Promise<AgentPlan[]> {
  const plans: AgentPlan[] = [];
  for (const agent of agents) {
    switch (agent) {
      case "claude":
        plans.push(await planClaude(read));
        break;
      case "cursor":
        plans.push(await planCursor(read));
        break;
      case "codex":
        plans.push(await planCodex(read));
        break;
      case "qoder":
        plans.push(await planQoder(read));
        break;
      case "antigravity":
        plans.push(planAntigravity());
        break;
    }
  }
  return plans;
}
