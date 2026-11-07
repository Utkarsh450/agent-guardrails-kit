import { planFiles, type DesiredFile, type PlannedFile, type ReadExisting } from "../../shared/fs-plan.ts";
import {
  BUG_REPORT_TEMPLATE,
  CODEOWNERS_TEMPLATE,
  FEATURE_REQUEST_TEMPLATE,
  PULL_REQUEST_TEMPLATE,
  workflowYaml,
  type WorkflowOptions,
} from "./templates.ts";

export { ACTIONS, workflowYaml, type WorkflowOptions } from "./templates.ts";
export { branchProtectionBody, branchProtectionCommand, type BranchProtectionTarget } from "./branch-protection.ts";

export const WORKFLOW_PATH = ".github/workflows/agent-guardrails.yml";

/**
 * Files for the project's .github folder. They are created once and are the user's afterwards
 * (generated: false), so an existing pull request template or workflow is never overwritten.
 */
export function desiredGithubFiles(options: WorkflowOptions = {}): DesiredFile[] {
  return [
    { path: ".github/pull_request_template.md", content: PULL_REQUEST_TEMPLATE, generated: false },
    { path: ".github/ISSUE_TEMPLATE/bug_report.md", content: BUG_REPORT_TEMPLATE, generated: false },
    { path: ".github/ISSUE_TEMPLATE/feature_request.md", content: FEATURE_REQUEST_TEMPLATE, generated: false },
    { path: ".github/CODEOWNERS", content: CODEOWNERS_TEMPLATE, generated: false },
    { path: WORKFLOW_PATH, content: workflowYaml(options), generated: false },
  ];
}

export function planGithubFiles(read: ReadExisting, options: WorkflowOptions = {}): Promise<PlannedFile[]> {
  return planFiles(desiredGithubFiles(options), read);
}
