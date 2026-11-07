import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { memoryIo } from "../../../tests/helpers/memory-io.ts";
import { ACTIONS, branchProtectionBody, branchProtectionCommand, desiredGithubFiles, planGithubFiles, workflowYaml, WORKFLOW_PATH } from "./index.ts";

describe("planGithubFiles", () => {
  it("creates every file in a fresh project", async () => {
    const plan = await planGithubFiles(memoryIo().readExisting);
    expect(plan.map((file) => file.path)).toEqual([
      ".github/pull_request_template.md",
      ".github/ISSUE_TEMPLATE/bug_report.md",
      ".github/ISSUE_TEMPLATE/feature_request.md",
      ".github/CODEOWNERS",
      ".github/workflows/agent-guardrails.yml",
    ]);
    expect(plan.every((file) => file.status === "create")).toBe(true);
  });

  it("never overwrites files the project already has", async () => {
    const io = memoryIo({ ".github/pull_request_template.md": "our own template", ".github/CODEOWNERS": "* @team" });
    const plan = await planGithubFiles(io.readExisting);
    expect(plan.find((file) => file.path.endsWith("pull_request_template.md"))?.status).toBe("conflict");
    expect(plan.find((file) => file.path.endsWith("CODEOWNERS"))?.status).toBe("conflict");
    expect(plan.find((file) => file.path.endsWith("bug_report.md"))?.status).toBe("create");
  });

  it("is idempotent", async () => {
    const io = memoryIo();
    const first = await planGithubFiles(io.readExisting);
    for (const file of first) io.files.set(file.path, file.content);
    expect((await planGithubFiles(io.readExisting)).every((file) => file.status === "unchanged")).toBe(true);
  });
});

describe("pull request and issue templates", () => {
  const byPath = (rel: string) => desiredGithubFiles().find((file) => file.path === rel)?.content ?? "";

  it("ask the questions that matter for AI-assisted work", () => {
    const pr = byPath(".github/pull_request_template.md");
    expect(pr).toMatch(/No secrets, tokens or `\.env` files/);
    expect(pr).toMatch(/new dependency was added on purpose/);
    expect(pr).toMatch(/AI agent helped/);
  });

  it("issue templates have valid frontmatter", () => {
    for (const rel of [".github/ISSUE_TEMPLATE/bug_report.md", ".github/ISSUE_TEMPLATE/feature_request.md"]) {
      const block = /^---\n([\s\S]*?)\n---/.exec(byPath(rel))?.[1] ?? "";
      const data = parseYaml(block) as Record<string, unknown>;
      expect(typeof data.name, rel).toBe("string");
      expect(typeof data.about, rel).toBe("string");
    }
  });

  it("CODEOWNERS starts with no active rules, so it cannot name a wrong owner", () => {
    const active = byPath(".github/CODEOWNERS").split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    expect(active).toEqual([]);
  });
});

describe("CI workflow", () => {
  const doc = parseYaml(workflowYaml()) as any;

  it("is valid YAML with a job named guardrails (the status check to require)", () => {
    expect(doc.name).toBe("agent-guardrails");
    expect(doc.jobs.guardrails.name).toBe("guardrails");
    expect(doc.on.pull_request).toBeNull();
    expect(doc.on.push.branches).toEqual(["main"]);
  });

  it("grants read-only access and does not keep credentials around", () => {
    expect(doc.permissions).toEqual({ contents: "read" });
    const checkout = doc.jobs.guardrails.steps[0];
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(checkout.with["fetch-depth"]).toBe(0);
  });

  it("pins third-party actions to full commit SHAs", () => {
    const uses = (doc.jobs.guardrails.steps as Array<{ uses?: string }>).map((step) => step.uses).filter(Boolean) as string[];
    expect(uses).toHaveLength(2);
    for (const use of uses) expect(use).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    expect(uses[0]).toBe(`actions/checkout@${ACTIONS.checkout.sha}`);
    expect(ACTIONS.checkout.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(ACTIONS.setupNode.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("passes the base branch through an environment variable, never straight into the shell line", () => {
    const text = workflowYaml();
    expect(text).not.toMatch(/run:.*\$\{\{/);
    const scan = (doc.jobs.guardrails.steps as any[]).find((step) => step.env?.BASE_REF);
    expect(scan.env.BASE_REF).toBe("${{ github.base_ref }}");
    expect(scan.run).toBe('node .agent-guardrails/git-checks.mjs scan-range "origin/$BASE_REF...HEAD"');
    expect(scan.if).toBe("github.event_name == 'pull_request'");
  });

  it("only runs the doctor step when a published package is named", () => {
    expect(workflowYaml()).toContain("# - name: Verify the guardrails are installed");
    const withDoctor = parseYaml(workflowYaml({ doctor: { packageName: "agent-guardrails-kit", version: "1.2.3" } })) as any;
    const steps = withDoctor.jobs.guardrails.steps as Array<{ run?: string }>;
    expect(steps.at(-1)?.run).toBe("npx --yes agent-guardrails-kit@1.2.3 doctor --ci");
    expect(doc.jobs.guardrails.steps).toHaveLength(3);
  });

  it("uses the Node version asked for", () => {
    expect((parseYaml(workflowYaml({ nodeVersion: 24 })) as any).jobs.guardrails.steps[1].with["node-version"]).toBe(24);
  });

  it("is placed where GitHub reads workflows", () => {
    expect(WORKFLOW_PATH).toBe(".github/workflows/agent-guardrails.yml");
  });
});

describe("branch protection", () => {
  it("builds a command for the person to run, with a JSON body GitHub accepts", () => {
    const command = branchProtectionCommand({ owner: "acme", repo: "app", branch: "main" });
    expect(command.startsWith("gh api --method PUT repos/acme/app/branches/main/protection --input - <<'JSON'\n")).toBe(true);
    expect(command.endsWith("\nJSON")).toBe(true);
    const body = JSON.parse(command.split("<<'JSON'\n")[1]!.replace(/\nJSON$/, "")) as Record<string, any>;
    expect(body.allow_force_pushes).toBe(false);
    expect(body.allow_deletions).toBe(false);
    expect(body.enforce_admins).toBe(true);
    expect(body.required_status_checks.contexts).toEqual(["guardrails"]);
    expect(body.required_pull_request_reviews.required_approving_review_count).toBe(1);
  });

  it("allows branch names with slashes and a custom status check", () => {
    expect(branchProtectionCommand({ owner: "a", repo: "b", branch: "release/1.0", statusCheck: "CI / test" })).toContain("branches/release/1.0/protection");
    expect(branchProtectionBody("CI / test").required_status_checks).toMatchObject({ contexts: ["CI / test"] });
  });

  it.each([
    [{ owner: "acme; rm -rf ~", repo: "app", branch: "main" }],
    [{ owner: "acme", repo: "app && curl x", branch: "main" }],
    [{ owner: "acme", repo: "app", branch: "main$(id)" }],
    [{ owner: "acme", repo: "app", branch: "../x" }],
    [{ owner: "", repo: "app", branch: "main" }],
    [{ owner: "acme", repo: "app", branch: "main", statusCheck: "x'; echo" }],
    [{ owner: "ac me", repo: "app", branch: "main" }],
  ])("refuses a value that could smuggle something into the shell: %j", (target) => {
    expect(() => branchProtectionCommand(target)).toThrow(/Invalid/);
  });
});
