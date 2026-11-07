/**
 * Branch protection is the one guardrail that lives on GitHub, not in the project. A file cannot switch it
 * on, so the kit gives the person one command to run themselves (agents are not allowed to run `gh`).
 * The command is optional: every other layer works without it.
 */

const NAME = /^[A-Za-z0-9._-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

export interface BranchProtectionTarget {
  owner: string;
  repo: string;
  branch: string;
  /** Name of the CI job that must pass. */
  statusCheck?: string;
}

/** The settings sent to GitHub's branch protection API. */
export function branchProtectionBody(statusCheck = "guardrails"): Record<string, unknown> {
  return {
    required_status_checks: { strict: true, contexts: [statusCheck] },
    enforce_admins: true,
    required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_code_owner_reviews: false },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

/** A copy-paste command for the person to run. Values are validated so nothing can be smuggled into the shell line. */
export function branchProtectionCommand({ owner, repo, branch, statusCheck }: BranchProtectionTarget): string {
  if (!NAME.test(owner)) throw new Error(`Invalid GitHub owner: "${owner}"`);
  if (!NAME.test(repo)) throw new Error(`Invalid repository name: "${repo}"`);
  if (!BRANCH.test(branch) || branch.includes("..")) throw new Error(`Invalid branch name: "${branch}"`);
  if (statusCheck !== undefined && !/^[A-Za-z0-9 ._/()-]+$/.test(statusCheck)) throw new Error(`Invalid status check name: "${statusCheck}"`);

  const body = JSON.stringify(branchProtectionBody(statusCheck), null, 2);
  return `gh api --method PUT repos/${owner}/${repo}/branches/${branch}/protection --input - <<'JSON'\n${body}\nJSON`;
}
