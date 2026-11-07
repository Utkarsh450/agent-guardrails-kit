import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * Regression test. guard.mjs and git-checks.mjs run themselves when started as a script. When the kit's CLI
 * bundles them as ordinary code, they must NOT start: a guard that read stdin and exited inside the CLI
 * would break every command. This bundles them the way scripts/build.mjs does and runs the result.
 * The bundle is written to dist/ (gitignored) and overwritten on each run; nothing is deleted.
 */

const rawPlugin = {
  name: "raw",
  setup(b: import("esbuild").PluginBuild) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")), namespace: "raw" }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({ contents: await readFile(args.path, "utf8"), loader: "text" }));
  },
};

describe("bundling the guard and git checks into another program", () => {
  it("does not start them: the bundle runs its own code and exits normally", async () => {
    const root = process.cwd();
    const entry = path.join(root, "dist", ".bundle-safety-entry.mjs");
    const out = path.join(root, "dist", ".bundle-safety-check.mjs");
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(
      entry,
      [
        `import { planHash, guardSource, runCorpusInProcess } from ${JSON.stringify(path.join(root, "src/features/hooks/index.ts"))};`,
        `import { desiredGitFiles, checksSource } from ${JSON.stringify(path.join(root, "src/features/git/index.ts"))};`,
        `import { scanText } from ${JSON.stringify(path.join(root, "src/features/secrets/index.ts"))};`,
        `console.log(JSON.stringify({ ok: true, hash: planHash("x").length, guard: guardSource.length > 1000, checks: checksSource.length > 1000, files: desiredGitFiles().length, scan: scanText("a").length }));`,
      ].join("\n"),
      "utf8",
    );
    await build({
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      plugins: [rawPlugin],
      logLevel: "error",
    });

    // Run with an empty stdin and a flag-like argument, as a hook or a user command would.
    const result = spawnSync(process.execPath, [out, "pre-commit", "--agent", "claude"], { cwd: root, input: "", encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, hash: 64, guard: true, checks: true, files: 3, scan: 0 });
    expect(result.stderr).toBe("");
  });

  it("still runs when installed under its real name", async () => {
    const root = process.cwd();
    const copy = path.join(root, "dist", ".copied-guard", "guard.mjs");
    await mkdir(path.dirname(copy), { recursive: true });
    await writeFile(copy, await readFile(path.join(root, "src/features/hooks/guard/guard.mjs"), "utf8"), "utf8");
    const out = spawnSync(process.execPath, [copy, "--agent", "claude", "--root", root], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf x" }, cwd: root }),
      encoding: "utf8",
      env: { ...process.env, AGENT_GUARDRAILS_NO_AUDIT: "1" },
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("file-deletion");
  });
});
