import type { AgentId } from "../../shared/agents.ts";
import type { PlannedFile } from "../../shared/fs-plan.ts";

/** "enforced" means a hook blocks actions; "advisory" means the agent is only asked to follow the rules. */
export type Enforcement = "enforced" | "advisory";

export interface AgentPlan {
  agent: AgentId;
  enforcement: Enforcement;
  /** Config files to create or merge into (rules are planned by the rules feature). */
  files: PlannedFile[];
  /** Steps only the user can do (trusting a hook, editing a file outside the project, restarting an app). */
  notes: string[];
}
