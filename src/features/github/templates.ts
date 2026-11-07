/** Actions are pinned to a commit, not a tag, so a moved or hijacked tag cannot change what CI runs. */
export const ACTIONS = {
  checkout: { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" },
  setupNode: { sha: "949feb2413d6458794dcd2491c4babbbce0c15c1", version: "v7.1.0" },
} as const;

export const PULL_REQUEST_TEMPLATE = `## What changed

<!-- A short summary of the change. -->

## Why

<!-- The problem this solves, or a link to the issue. -->

## How it was checked

- [ ] Tests pass and the change was tried by hand where it matters
- [ ] No secrets, tokens or \`.env\` files are included
- [ ] Any new dependency was added on purpose: the name was checked and not invented or misspelled
- [ ] The rules in \`agent-rules/\` and the guardrail files were not weakened

## AI assistance

- [ ] An AI agent helped write this change (which one: ...)
- [ ] I read the whole diff myself before asking for review
`;

export const BUG_REPORT_TEMPLATE = `---
name: Bug report
about: Something does not work as expected
title: ""
labels: bug
assignees: ""
---

**What happened**

**What you expected**

**How to reproduce**

1.
2.

**Environment** (OS, Node version, package manager, which AI agent if relevant)
`;

export const FEATURE_REQUEST_TEMPLATE = `---
name: Feature request
about: Suggest an improvement
title: ""
labels: enhancement
assignees: ""
---

**The problem**

**The change you would like**

**Alternatives you considered**
`;

export const CODEOWNERS_TEMPLATE = `# CODEOWNERS: who must review changes to these files.
#
# Replace @your-github-username (or a team such as @your-org/security) and remove the leading "#".
# With branch protection's "Require review from Code Owners" turned on, changes to the files below
# cannot be merged without that person's approval. They are the files that keep AI agents in check.
#
# /.agent-guardrails/            @your-github-username
# /.githooks/                    @your-github-username
# /.github/workflows/            @your-github-username
# /agent-rules/                  @your-github-username
# /agent-guardrails.config.json  @your-github-username
# /.claude/settings.json         @your-github-username
# /.cursor/hooks.json            @your-github-username
# /.codex/                       @your-github-username
# /.qoder/settings.json          @your-github-username
`;

export interface WorkflowOptions {
  /** When set, the workflow also runs \`doctor --ci\` from this published package version. */
  doctor?: { packageName: string; version: string };
  /** Node version CI runs the checks with. */
  nodeVersion?: number;
}

export function workflowYaml({ doctor, nodeVersion = 22 }: WorkflowOptions = {}): string {
  const doctorStep = doctor
    ? `
      - name: Verify the guardrails are installed
        run: npx --yes ${doctor.packageName}@${doctor.version} doctor --ci
`
    : `
      # Once the agent-guardrails package is published, add a step that checks the installation:
      # - name: Verify the guardrails are installed
      #   run: npx --yes <package>@<version> doctor --ci
`;

  return `# Created by agent-guardrails. This file is yours now; edit it freely.
# Third-party actions are pinned to a commit so a moved tag cannot change what runs.
name: agent-guardrails

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  guardrails:
    name: guardrails
    runs-on: ubuntu-latest
    steps:
      - name: Check out the code
        uses: actions/checkout@${ACTIONS.checkout.sha} # ${ACTIONS.checkout.version}
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Set up Node
        uses: actions/setup-node@${ACTIONS.setupNode.sha} # ${ACTIONS.setupNode.version}
        with:
          node-version: ${nodeVersion}

      - name: Scan the pull request for secrets and risky dependency changes
        if: github.event_name == 'pull_request'
        env:
          BASE_REF: \${{ github.base_ref }}
        run: node .agent-guardrails/git-checks.mjs scan-range "origin/$BASE_REF...HEAD"
${doctorStep}`;
}
