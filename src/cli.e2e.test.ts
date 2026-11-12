import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { posixShell } from "../tests/helpers/shell.ts";

/**
 * Drives the real built CLI (dist/cli.mjs) as a separate process against throwaway projects, the way a person
 * would from a terminal. Temp folders and git repos live under the system temp directory and are left for the OS
 * to clean up (the kit's rules forbid deleting files).
 */

const root = process.cwd();
const cli = path.join(root, "dist", "cli.mjs");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", NO_COLOR: "1", FORCE_COLOR: "0" };

beforeAll(() => {
  const build = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { cwd: root, encoding: "utf8" });
  expect(build.status, build.stderr).toBe(0);
}, 120_000);

async function project(files: Record<string, string> = {}, { git = true } = {}): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-e2e-cli-")));
  if (git) spawnSync("git", ["init", "-q"], { cwd: dir, env });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return dir;
}

function run(dir: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cli, "--cwd", dir, ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8", input: "" });
  return { code: result.status, out: result.stdout, err: result.stderr, all: `${result.stdout}\n${result.stderr}` };
}

const read = (dir: string, rel: string) => readFile(path.join(dir, rel), "utf8");

/** A project set up the way a person would: init with flags, git hooks switched on. */
async function initialised(agents = "claude,cursor,codex,qoder", extra: string[] = []): Promise<string> {
  const dir = await project({ "package.json": JSON.stringify({ name: "demo", packageManager: "pnpm@11.0.0" }) });
  const result = run(dir, ["init", "--agents", agents, "--yes", "--git-config", ...extra]);
  expect(result.code, result.all).toBe(0);
  return dir;
}

describe("basics", () => {
  it("prints its version and help", () => {
    const dir = os.tmpdir();
    expect(run(dir, ["--version"]).out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = run(dir, ["--help"]);
    expect(help.code).toBe(0);
    for (const name of ["init", "doctor", "sync", "approve", "report", "allow", "preset", "explain", "test", "update"]) expect(help.out).toContain(name);
  });

  it("shows the package name and version first, on help and on every command", async () => {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { name: string; version: string };
    expect(run(os.tmpdir(), ["--help"]).out.startsWith(`${pkg.name} v${pkg.version}\n`)).toBe(true);
    const dir = await project();
    expect(run(dir, ["init", "--agents", "claude", "--dry-run"]).out.startsWith(`${pkg.name} v${pkg.version} · agent-guardrails-kit init\n`)).toBe(true);
    expect(run(dir, ["doctor"]).out).toContain(`${pkg.name} v${pkg.version} · agent-guardrails-kit doctor`);
  });

  it("rejects an unknown command with a helpful message and a non-zero exit code", () => {
    const result = run(os.tmpdir(), ["frobnicate"]);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/unknown command/i);
  });
});

describe("init", () => {
  it("installs everything, turns the git hooks on, and the doctor is happy", async () => {
    const dir = await initialised();
    for (const file of [
      ".agent-guardrails/guard.mjs", ".agent-guardrails/git-checks.mjs", "agent-guardrails.config.json", "AGENTS.md", "CLAUDE.md", ".claude/settings.json",
      ".cursor/hooks.json", ".codex/hooks.json", ".qoder/settings.json", ".githooks/pre-commit", ".github/workflows/agent-guardrails.yml", "agent-rules/always/safety.md",
    ]) expect(await read(dir, file), file).toBeTruthy();

    const hooksPath = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: dir, env, encoding: "utf8" });
    expect(hooksPath.stdout.trim()).toBe(".githooks");

    const doctor = run(dir, ["doctor", "--ci"]);
    expect(doctor.code, doctor.all).toBe(0);
    expect(doctor.out).not.toContain("[FAIL]");
    expect(doctor.out).toMatch(/\d+ ok, 0 warning\(s\), 0 problem\(s\)/);
  });

  it("without --yes it shows the plan and refuses to write when nobody can answer", async () => {
    const dir = await project();
    const result = run(dir, ["init", "--agents", "claude"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Plan:");
    expect(result.all).toContain("run again with --yes");
    await expect(read(dir, "AGENTS.md")).rejects.toThrow();
  });

  it("--dry-run writes nothing and exits 0", async () => {
    const dir = await project();
    const result = run(dir, ["init", "--agents", "claude,codex", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Dry run: nothing was written.");
    await expect(read(dir, ".claude/settings.json")).rejects.toThrow();
  });

  it("explains a missing choice and refuses the home folder", async () => {
    const dir = await project();
    const noAgents = run(dir, ["init", "--yes"]);
    expect(noAgents.code).toBe(1);
    expect(noAgents.err).toContain("Say which agents");
    const home = run(os.homedir(), ["init", "--agents", "claude", "--yes"]);
    expect(home.code).toBe(1);
    expect(home.err).toContain("home folder");
  });
});

describe("the installed protection really works", () => {
  it("the Claude Code hook written by init blocks and allows", async () => {
    const dir = await initialised("claude");
    const settings = JSON.parse(await read(dir, ".claude/settings.json"));
    const command = settings.hooks.PreToolUse[0].hooks[0].command as string;
    const hook = (cmd: string) =>
      spawnSync(posixShell(), ["-c", command], { cwd: dir, encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: dir }, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd }, cwd: dir }) });
    expect(hook("rm -rf x").status).toBe(2);
    expect(hook("git push").status).toBe(2);
    expect(hook("git status").status).toBe(0);
  });

  it("the git hooks written by init block a secret commit", async () => {
    const dir = await initialised("claude");
    await writeFile(path.join(dir, ".env"), "TOKEN=abc\n", "utf8");
    spawnSync("git", ["add", "-f", ".env"], { cwd: dir, env });
    const commit = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x"], { cwd: dir, env, encoding: "utf8" });
    expect(commit.status).not.toBe(0);
    expect(commit.stderr).toContain(".env: is a secret or credentials file");
  });

  it("`test --hooks` proves the installed guard", async () => {
    const dir = await initialised("claude,cursor");
    const result = run(dir, ["test", "--hooks"]);
    expect(result.code, result.all).toBe(0);
    expect(result.out).toMatch(/in-process: (\d+)\/\1 passed/);
    expect(result.out).toMatch(/Claude Code: (\d+)\/\1 passed/);
    expect(result.out).toMatch(/Cursor: (\d+)\/\1 passed/);
    expect(result.out).toContain("Everything passed");
  }, 180_000);

  it("`test --hooks` fails clearly when the guard is not installed", async () => {
    const dir = await project();
    const result = run(dir, ["test", "--hooks"]);
    expect(result.code).toBe(1);
    expect(result.all).toContain("is not installed");
  }, 120_000);
});

describe("doctor", () => {
  it("finds a missing hook and says how to fix it", async () => {
    const dir = await initialised("claude");
    const settings = JSON.parse(await read(dir, ".claude/settings.json"));
    delete settings.hooks;
    await writeFile(path.join(dir, ".claude/settings.json"), JSON.stringify(settings), "utf8");
    const result = run(dir, ["doctor"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("[FAIL] Claude Code: guard hook");
    expect(result.out).toContain("fix: agent-guardrails-kit init");
  });

  it("prints JSON when asked, and fails in an empty folder", async () => {
    const dir = await initialised("claude");
    const json = JSON.parse(run(dir, ["doctor", "--json"]).out) as { checks: unknown[]; counts: { fail: number } };
    expect(json.checks.length).toBeGreaterThan(5);
    expect(json.counts.fail).toBe(0);
    const empty = await project({}, { git: false });
    expect(run(empty, ["doctor", "--ci"]).code).toBe(1);
  });
});

describe("running from inside a project", () => {
  it("finds the project from a subfolder", async () => {
    const dir = await initialised("claude");
    await mkdir(path.join(dir, "src", "deep"), { recursive: true });
    const result = run(path.join(dir, "src", "deep"), ["doctor", "--ci"]);
    expect(result.code, result.all).toBe(0);
    expect(result.out).toContain("[ok  ] Guard script");
    expect(run(path.join(dir, "src", "deep"), ["approve", "--status"]).code).toBe(1);
  });
});

describe("agents cannot use the CLI to widen their own permissions", () => {
  it("the installed guard hard-blocks every state-changing command, even through npx", async () => {
    const dir = await initialised("claude");
    const settings = JSON.parse(await read(dir, ".claude/settings.json"));
    const command = settings.hooks.PreToolUse[0].hooks[0].command as string;
    const hook = (cmd: string) =>
      spawnSync(posixShell(), ["-c", command], { cwd: dir, encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: dir }, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd }, cwd: dir }) });
    for (const cmd of ["agent-guardrails-kit approve --yes", "npx agent-guardrails-kit approve -y", "pnpm dlx agent-guardrails-kit allow add node", "agent-guardrails --cwd . init --yes"]) {
      const out = hook(cmd);
      expect(out.status, cmd).toBe(2);
      expect(out.stderr, cmd).toContain("guardrails-cli");
    }
    // Even a project that allow-lists the whole program cannot let an agent approve its own plan.
    await writeFile(path.join(dir, "agent-guardrails.config.json"), JSON.stringify({ allowCommands: ["agent-guardrails"], agents: ["claude"] }), "utf8");
    expect(hook("agent-guardrails-kit approve --yes").status).toBe(2);
    expect(hook("agent-guardrails-kit doctor").status).toBe(0);
  });
});

describe("approve", () => {
  it("walks the plan gate: not approved, approve, edit cancels it", async () => {
    const dir = await initialised("claude");
    expect(run(dir, ["approve", "--status"]).code).toBe(1);
    expect(run(dir, ["approve", "--yes"]).err).toContain("There is no PLAN.md yet");

    await writeFile(path.join(dir, "PLAN.md"), "# Plan\n- build the thing\n", "utf8");
    const noYes = run(dir, ["approve"]);
    expect(noYes.code).toBe(1);
    expect(noYes.err).toContain("--yes");

    const approved = run(dir, ["approve", "--yes"]);
    expect(approved.code, approved.all).toBe(0);
    expect(approved.out).toMatch(/Approved PLAN\.md \(fingerprint [0-9a-f]{12}\)/);
    expect(run(dir, ["approve", "--status"]).code).toBe(0);

    // the guard now lets a file write through, until the plan changes
    const settings = JSON.parse(await read(dir, ".claude/settings.json"));
    const command = settings.hooks.PreToolUse[0].hooks[0].command as string;
    const write = () =>
      spawnSync(posixShell(), ["-c", command], { cwd: dir, encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: dir }, input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(dir, "src/a.ts"), content: "x" }, cwd: dir }) }).status;
    expect(write()).toBe(0);
    await writeFile(path.join(dir, "PLAN.md"), "# Plan\n- build the thing\n- and something sneaky\n", "utf8");
    expect(run(dir, ["approve", "--status"]).code).toBe(1);
    expect(write()).toBe(2);

    expect(run(dir, ["approve", "--yes"]).code).toBe(0);
    expect(run(dir, ["approve", "--revoke", "--yes"]).code).toBe(0);
    expect(run(dir, ["approve", "--status"]).code).toBe(1);
    expect(write()).toBe(2);
  });
});

describe("allow", () => {
  it("adds, lists and removes commands, refusing the ones that can never be allowed", async () => {
    // learner starts with an empty allow list; balanced now allows the stack's test and build commands.
    const dir = await initialised("claude", ["--preset", "learner"]);
    expect(run(dir, ["allow", "list"]).out).toContain("No commands are allowed");

    const add = run(dir, ["allow", "add", "pnpm test", "--yes"]);
    expect(add.code, add.all).toBe(0);
    expect(JSON.parse(await read(dir, "agent-guardrails.config.json")).allowCommands).toEqual(["pnpm test"]);
    expect(run(dir, ["allow", "list"]).out).toContain("pnpm test");
    expect(run(dir, ["allow", "add", "pnpm test", "--yes"]).out).toContain("already allowed");

    const hard = run(dir, ["allow", "add", "rm -rf dist", "--yes"]);
    expect(hard.code).toBe(1);
    expect(hard.err).toContain("always blocked");
    const star = run(dir, ["allow", "add", "*", "--yes"]);
    expect(star.code).toBe(1);
    expect(star.err).toContain('not "*"');
    expect(run(dir, ["allow", "add", "npx cowsay", "--yes"]).err).toContain("would still ask");
    expect(run(dir, ["allow", "add", "ls", "--yes"]).out).toContain("already runs without asking");
    expect(run(dir, ["allow", "add", "python", "--yes"]).code).toBe(0); // broad, but --yes was given

    expect(run(dir, ["allow", "remove", "pnpm test", "--yes"]).code).toBe(0);
    expect(JSON.parse(await read(dir, "agent-guardrails.config.json")).allowCommands).toEqual(["python"]);
    expect(run(dir, ["allow", "remove", "nothing", "--yes"]).code).toBe(1);
  });
});

describe("sync, update and preset", () => {
  it("sync --check notices a changed rule, and sync fixes it", async () => {
    const dir = await initialised("claude");
    expect(run(dir, ["sync", "--check"]).code).toBe(0);
    await writeFile(path.join(dir, "agent-rules/always/repo.md"), "---\ndescription: Changed\n---\n\n# Changed\n\nA brand new rule line.", "utf8");
    const check = run(dir, ["sync", "--check"]);
    expect(check.code).toBe(1);
    expect(check.all).toContain("out of date");
    expect(run(dir, ["sync", "--yes"]).code).toBe(0);
    expect(await read(dir, "AGENTS.md")).toContain("A brand new rule line.");
    expect(run(dir, ["sync", "--check"]).code).toBe(0);
  });

  it("update restores a tampered guard", async () => {
    const dir = await initialised("claude");
    const good = await read(dir, ".agent-guardrails/guard.mjs");
    await writeFile(path.join(dir, ".agent-guardrails/guard.mjs"), `${good}\n// tampered\n`, "utf8");
    expect(run(dir, ["doctor"]).out).toContain("[warn] Guard script");
    expect(run(dir, ["update", "--yes"]).code).toBe(0);
    expect(await read(dir, ".agent-guardrails/guard.mjs")).toBe(good);
  });

  it("preset replaces the settings only after asking", async () => {
    const dir = await initialised("claude");
    const denied = run(dir, ["preset", "team"]);
    expect(denied.code).toBe(1);
    expect(denied.all).toContain("--yes");
    expect(JSON.parse(await read(dir, "agent-guardrails.config.json")).preset).toBe("balanced");
    expect(run(dir, ["preset", "team", "--yes"]).code).toBe(0);
    const config = JSON.parse(await read(dir, "agent-guardrails.config.json"));
    expect(config.preset).toBe("team");
    expect(config.allowCommands).toContain("pnpm test");
    expect(run(dir, ["preset", "wild", "--yes"]).code).toBe(1);
  });
});

describe("report and explain", () => {
  it("reports what the guard blocked", async () => {
    const dir = await initialised("claude");
    expect(run(dir, ["report"]).out).toContain("No audit log yet");

    const settings = JSON.parse(await read(dir, ".claude/settings.json"));
    const command = settings.hooks.PreToolUse[0].hooks[0].command as string;
    const guardEnv = { ...env, CLAUDE_PROJECT_DIR: dir, AGENT_GUARDRAILS_NO_AUDIT: "0" };
    for (const cmd of ["rm -rf x", "git push origin main", "python script.py"]) {
      spawnSync(posixShell(), ["-c", command], { cwd: dir, env: guardEnv, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd }, cwd: dir }) });
    }
    const report = run(dir, ["report"]);
    expect(report.code).toBe(0);
    expect(report.out).toContain("3 recorded action(s)");
    expect(report.out).toContain("blocked: 2   asked: 1");
    expect(report.out).toContain("Deleting files");
    expect(report.out).toContain("git push origin main");
    const json = JSON.parse(run(dir, ["report", "--json"]).out) as { summary: { total: number } };
    expect(json.summary.total).toBe(3);
  });

  it("explains rules, topics and agents, and suggests names for typos", async () => {
    const dir = os.tmpdir();
    const rule = run(dir, ["explain", "git-write"]);
    expect(rule.code).toBe(0);
    expect(rule.out).toContain("git-write: Changing git");
    expect(rule.out).toContain("Why:");
    expect(run(dir, ["explain", "antigravity"]).out).toContain("command(rm)");
    expect(run(dir, ["explain"]).out).toContain("Topics:");
    const typo = run(dir, ["explain", "git-wrte"]);
    expect(typo.code).toBe(1);
    expect(typo.err).toContain("Nothing to explain");
  });
});

describe("test --prompt", () => {
  it("prints the red-team prompt for the agent, with how to use it", async () => {
    const dir = await initialised("codex");
    const result = run(dir, ["test", "--prompt"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("throwaway copy");
    expect(result.out).toContain("# Guardrail test");
    expect(result.out).toContain("Codex cannot ask me questions");
    expect(run(dir, ["test", "--prompt", "--agent", "antigravity"]).out).toContain("no hooks");
    const gap = run(dir, ["test", "--gap-review"]);
    expect(gap.out).toContain("Guardrail gap review");
    expect(gap.out).toMatch(/\d+ ok, \d+ warning\(s\)/);
  });
});

describe("ui (the read-only dashboard)", () => {
  it("starts on the loopback address, serves the project, refuses writes, and stops on Ctrl+C", async () => {
    const dir = await initialised("claude");
    const child = spawn(process.execPath, [cli, "--cwd", dir, "ui", "--port", "0"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no URL printed:\n${output}`)), 15_000);
      const check = () => {
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        } else setTimeout(check, 50);
      };
      check();
    });

    const overview = (await (await fetch(`${url}/api/overview`)).json()) as { project: { configured: boolean }; doctor: { counts: { fail: number } } };
    expect(overview.project.configured).toBe(true);
    expect(overview.doctor.counts.fail).toBe(0);
    expect((await fetch(`${url}/api/approve`, { method: "POST" })).status).toBe(405);
    expect(output).toContain("read-only");

    const exit = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    child.kill("SIGINT");
    const code = await exit;
    // Windows cannot send Ctrl+C from a script: the signal ends the process on the spot, with no goodbye message.
    if (process.platform === "win32") {
      expect(code === 0 || code === null).toBe(true);
      return;
    }
    expect(code).toBe(0);
    expect(output).toContain("Dashboard stopped.");
  }, 60_000);

  it("complains clearly about a bad port", async () => {
    const dir = await initialised("claude");
    const result = run(dir, ["ui", "--port", "99999"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("not a valid port");
  });
});

describe("a second init changes nothing", () => {
  it("is idempotent from the command line", async () => {
    const dir = await initialised("claude,cursor");
    const before = await read(dir, ".claude/settings.json");
    const again = run(dir, ["init", "--agents", "claude,cursor", "--yes"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Everything is already set up.");
    expect(await read(dir, ".claude/settings.json")).toBe(before);
  });
});
