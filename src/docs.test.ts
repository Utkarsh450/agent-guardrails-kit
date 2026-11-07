import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { ACTIONS } from "./features/github/index.ts";
import { buildProgram } from "./program.ts";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const markdown = ["README.md", "SECURITY.md", "CONTRIBUTING.md", ...readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
const commandNames = buildProgram().commands.map((c) => c.name());

/** Code the reader is meant to type: fenced blocks and `inline code`. */
function codeOf(text: string): string[] {
  const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const inline = [...text.replaceAll(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
  return [...fenced, ...inline];
}

describe("the documentation matches the program", () => {
  it("only shows commands that exist", () => {
    const valid = new Set([...commandNames, "help"]);
    const bad: string[] = [];
    for (const file of markdown) {
      for (const code of codeOf(read(file))) {
        // The package name is also an argument to npm and grep; those are not CLI usages.
        const usage = code.replaceAll(/\bnpm (?:view|install|i)\s+\S+/g, "").replaceAll(/grep -rn "[^"]*"/g, "");
        for (const match of usage.matchAll(/agent-guardrails(?:-kit)?(?:@[\w.]+)?\s+(?:--cwd\s+\S+\s+)?([a-z][a-z-]*)/g)) {
          const word = match[1] ?? "";
          if (!valid.has(word)) bad.push(`${file}: "${match[0]}"`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("mentions every command in the README", () => {
    const readme = read("README.md");
    for (const name of commandNames) expect(readme, name).toMatch(new RegExp(`agent-guardrails ${name}\\b`));
  });

  it("only links to files that exist", () => {
    const broken: string[] = [];
    for (const file of markdown) {
      for (const match of read(file).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = match[1] ?? "";
        if (/^(https?:|mailto:)/.test(target)) continue;
        if (!existsSync(path.join(root, path.dirname(file), target))) broken.push(`${file} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("names the Node version the package needs", () => {
    expect(pkg.engines.node).toBe(">=22.12.0");
    expect(read("README.md")).toContain("Node 22.12 or newer");
    expect(read("CONTRIBUTING.md")).toContain("Node 22.12 or newer");
  });

  it("is honest about the limits that matter", () => {
    const limits = read("docs/LIMITS.md");
    for (const topic of ["Windows", "Antigravity", "MCP", "xargs", "blocklist", "allowCommands", "--no-verify", "Script files", "audit log", "not a sandbox"]) {
      expect(limits, topic).toContain(topic);
    }
    expect(read("README.md")).toContain("docs/LIMITS.md");
  });

  it("README promises only what the tool does", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/never deletes anything/);
    expect(readme).toMatch(/fails closed/i);
    expect(readme).toMatch(/Antigravity \| \*\*Advisory only\*\*/);
    expect(readme).not.toMatch(/guarantee|100%|unbreakable|bulletproof|foolproof/i);
  });
});

describe("the package is ready to publish", () => {
  it("ships only the built CLI, under both command names, and is still protected from accidental publishing", () => {
    expect(pkg.files).toEqual(["dist/cli.mjs"]);
    expect(pkg.bin).toEqual({ "agent-guardrails": "dist/cli.mjs", "agent-guardrails-kit": "dist/cli.mjs" });
    expect(pkg.private).toBe(true);
    expect(pkg.version).toBe("0.0.0");
    expect(pkg.scripts.prepublishOnly).toBe("npm run typecheck && npm run test && npm run build");
    expect(pkg.license).toBe("MIT");
    expect(pkg.description.length).toBeGreaterThan(40);
    expect(read("LICENSE").startsWith("MIT License")).toBe(true);
  });

  it("pins every dependency to an exact version", () => {
    for (const group of [pkg.dependencies, pkg.optionalDependencies, pkg.devDependencies]) {
      for (const [name, version] of Object.entries(group)) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("the publishing guide covers the safety steps and matches package.json", () => {
    const guide = read("docs/PUBLISHING.md");
    for (const step of ["npm view", "npm pack --dry-run", "npm publish --dry-run", "npm pkg delete private", "git status", "npm login", "git push -u origin main", "private vulnerability reporting"]) {
      expect(guide, step).toContain(step);
    }
    expect(guide.toLowerCase()).toContain("you run every step");
  });
});

describe("this repository's CI workflow", () => {
  const text = read(".github/workflows/ci.yml");
  const doc = parseYaml(text) as any;

  it("tests npm, pnpm and bun on Linux and macOS, and Windows only as an experiment", () => {
    const matrix = doc.jobs.test.strategy.matrix;
    expect(matrix.os).toEqual(["ubuntu-latest", "macos-latest"]);
    expect(matrix.pm).toEqual(["npm", "pnpm", "bun"]);
    expect(matrix.experimental).toEqual([false]);
    const windows = matrix.include.filter((entry: { os: string }) => entry.os === "windows-latest");
    expect(windows.map((entry: { pm: string }) => entry.pm).sort()).toEqual(["bun", "npm", "pnpm"]);
    for (const entry of matrix.include) expect(entry.experimental, JSON.stringify(entry)).toBe(entry.os === "windows-latest");
    expect(doc.jobs.test["continue-on-error"]).toBe("${{ matrix.experimental }}");
    expect(doc.jobs.test.strategy["fail-fast"]).toBe(false);
  });

  it("runs the same checks for every package manager, plus a smoke test of the built CLI", () => {
    const runs = (doc.jobs.test.steps as Array<{ run?: string }>).map((s) => s.run).filter(Boolean) as string[];
    expect(runs).toContain("${{ matrix.pm }} run typecheck");
    expect(runs).toContain("${{ matrix.pm }} run test");
    expect(runs).toContain("${{ matrix.pm }} run build");
    const smoke = runs.find((r) => r.includes("dist/cli.mjs")) ?? "";
    for (const part of ["init --agents claude,cursor,codex --yes --git-config", "doctor --ci", "test --hooks"]) expect(smoke, part).toContain(part);
  });

  it("checks the packed tarball the way a stranger would use it", () => {
    const runs = (doc.jobs.package.steps as Array<{ run?: string }>).map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("npm pack");
    expect(runs).toContain("npm install --no-audit --no-fund \"$RUNNER_TEMP\"/pack/*.tgz");
    expect(runs).toContain("npx agent-guardrails init");
  });

  it("is read-only, pins actions to commits, and keeps expressions out of shell lines", () => {
    expect(doc.permissions).toEqual({ contents: "read" });
    const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const use of uses) expect(use, use).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    expect(uses).toContain(`actions/checkout@${ACTIONS.checkout.sha}`);
    expect(uses).toContain(`actions/setup-node@${ACTIONS.setupNode.sha}`);
    for (const job of Object.values(doc.jobs) as Array<{ steps: Array<{ with?: Record<string, unknown>; uses?: string }> }>) {
      const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout"));
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    }
    // Only matrix values (a fixed list we wrote) may appear inside a run: line; everything else goes through env.
    for (const line of text.split("\n").filter((l) => /^\s*run:/.test(l))) {
      for (const expr of line.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)) expect(expr[1], line).toBe("matrix.pm");
    }
  });

  it("uses the same tool versions as package.json", () => {
    expect(text).toContain(`pnpm@${pkg.packageManager.split("@")[1]}`);
    expect(text).toMatch(/bun@\d+\.\d+\.\d+/);
  });
});
