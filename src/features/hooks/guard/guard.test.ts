import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG as TS_DEFAULT_CONFIG, GUARD_CONFIG_KEYS, parseConfig } from "../../../shared/config.ts";
import { decide, ROOT, shell, writeFile } from "../../../../tests/helpers/guard-ctx.ts";
import { fakeFs, makeContext } from "../sandbox.ts";
import {
  DEFAULT_CONFIG,
  hashPlan,
  lex,
  normalizeRequest,
  respond,
  runGuard,
  validateConfig,
  type Decision,
} from "./guard.mjs";

const ctxWith = (config: Record<string, unknown>) => makeContext({ config: config as never });

describe("policy: what happens to a command nobody has classified", () => {
  it("asks by default", () => {
    expect(shell("python script.py")).toMatchObject({ decision: "ask", rule: "unknown-command" });
  });

  it("allows under policy=blocklist, but never past a hard block", () => {
    const ctx = ctxWith({ policy: "blocklist" });
    expect(shell("python script.py", ctx).decision).toBe("allow");
    expect(shell("rm x", ctx).decision).toBe("deny");
    expect(shell("git push", ctx).decision).toBe("deny");
  });

  it("denies under policy=allowlist unless allow-listed", () => {
    const ctx = ctxWith({ policy: "allowlist", allowCommands: ["pnpm test"] });
    expect(shell("python script.py", ctx)).toMatchObject({ decision: "deny", rule: "not-allowed" });
    expect(shell("pnpm test", ctx).decision).toBe("allow");
    expect(shell("ls", ctx).decision).toBe("allow");
  });

  it("treats unparseable syntax as deny under allowlist and ask otherwise", () => {
    expect(shell("echo 'oops").decision).toBe("ask");
    expect(shell("echo 'oops", ctxWith({ policy: "allowlist" })).decision).toBe("deny");
  });
});

describe("allowCommands", () => {
  const ctx = ctxWith({ allowCommands: ["pnpm test", "pnpm build", "node scripts/build.mjs"] });

  it("lets listed commands run without asking", () => {
    expect(shell("pnpm test", ctx)).toMatchObject({ decision: "allow", rule: "user-allowed" });
    expect(shell("pnpm test --watch", ctx).decision).toBe("allow");
    expect(shell("pnpm build", ctx).decision).toBe("allow");
    expect(shell("node scripts/build.mjs", ctx).decision).toBe("allow");
  });

  it("does not allow near misses", () => {
    expect(shell("pnpm typecheck", ctx).decision).toBe("ask");
    expect(shell("node other.js", ctx).decision).toBe("ask");
    expect(shell("node scripts/other.mjs", ctx).decision).toBe("ask");
    expect(shell("node scripts/../other.mjs", ctx).decision).toBe("ask");
    expect(shell("pnpm  test", ctx).decision).toBe("allow"); // extra spaces are fine
    expect(shell("npm test", ctx).decision).toBe("ask");
  });

  it("looks through wrappers", () => {
    expect(shell("timeout 60 pnpm test", ctx).decision).toBe("allow");
    expect(shell("CI=1 pnpm test", ctx).decision).toBe("allow");
    expect(shell("env CI=1 pnpm test", ctx).decision).toBe("allow");
    expect(shell("nohup pnpm test", ctx).decision).toBe("allow");
  });

  it("checks every command in a chain", () => {
    expect(shell("pnpm test && pnpm build", ctx).decision).toBe("allow");
    expect(shell("pnpm test; pnpm typecheck", ctx).decision).toBe("ask");
    expect(shell("pnpm test && rm -rf dist", ctx).decision).toBe("deny");
    expect(shell("pnpm test | sh", ctx).decision).toBe("deny");
    expect(shell("pnpm test $(rm x)", ctx).decision).toBe("deny");
  });

  it("never allows dynamic arguments to slip through", () => {
    expect(shell("pnpm test $FILE", ctx).decision).toBe("ask");
    expect(shell("pnpm test /etc/passwd", ctx).decision).toBe("deny");
  });

  it("cannot override hard blocks, asks that are not about unknown commands, or inline code", () => {
    const wide = ctxWith({ allowCommands: ["rm", "git", "gh", "npm", "pnpm", "python", "node", "psql", "sudo"] });
    expect(shell("rm x", wide).decision).toBe("deny");
    expect(shell("git push", wide).decision).toBe("deny");
    expect(shell("gh pr list", wide).decision).toBe("deny");
    expect(shell("npm publish", wide).decision).toBe("deny");
    expect(shell("sudo ls", wide).decision).toBe("deny");
    expect(shell("pnpm add lodash", wide).decision).toBe("ask");
    expect(shell("python -c 'print(1)'", wide).decision).toBe("ask");
    expect(shell("python -c 'import os; os.remove(\"x\")'", wide).decision).toBe("deny");
    expect(shell("psql -c 'select 1'", wide).decision).toBe("ask");
    expect(shell("psql -c 'drop table x'", wide).decision).toBe("deny");
    expect(shell("python script.py", wide).decision).toBe("allow");
  });
});

describe("git allow list", () => {
  it("can be extended with read-only subcommands", () => {
    const ctx = ctxWith({ gitAllow: ["status", "diff", "log", "show", "ls-files", "rev-parse"] });
    expect(shell("git ls-files", ctx).decision).toBe("allow");
    expect(shell("git rev-parse HEAD", ctx).decision).toBe("allow");
    expect(shell("git push", ctx).decision).toBe("deny");
  });

  it("can never allow network or history-rewriting subcommands", () => {
    const ctx = ctxWith({ gitAllow: ["push", "pull", "fetch", "clone", "config", "reflog", "gc", "init"] });
    for (const sub of ["push", "pull", "fetch", "clone", "config x y", "reflog expire", "gc", "init"]) {
      expect(shell(`git ${sub}`, ctx).decision, sub).toBe("deny");
    }
  });

  it("matches subcommands case-insensitively and rejects aliases", () => {
    expect(shell("git STATUS").decision).toBe("allow");
    expect(shell("git st").decision).toBe("deny");
  });
});

describe("approval gate", () => {
  it("blocks writes until the plan is approved", () => {
    expect(writeFile(`${ROOT}/src/a.ts`)).toMatchObject({ decision: "deny", rule: "no-approved-plan" });
    expect(writeFile(`${ROOT}/src/a.ts`, "x", makeContext({ approved: true })).decision).toBe("allow");
  });

  it("always lets the agent write the plan itself", () => {
    expect(writeFile(`${ROOT}/PLAN.md`).decision).toBe("allow");
    expect(writeFile(`${ROOT}/plan.md`).decision).toBe("allow");
  });

  it("explains why an approval stopped counting", () => {
    const stale = makeContext({ approved: true });
    stale.fs = fakeFs({
      [`${ROOT}/PLAN.md`]: "# Plan\nchanged\n",
      [`${ROOT}/.agent-guardrails/approval.json`]: JSON.stringify({ version: 1, plan: "PLAN.md", sha256: hashPlan("# Plan\n- do the thing\n") }),
    });
    const result = writeFile(`${ROOT}/src/a.ts`, "x", stale);
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/changed after it was approved/);
  });

  it("denies when the approval record is broken or for another plan file", () => {
    const broken = makeContext();
    broken.fs = fakeFs({ [`${ROOT}/.agent-guardrails/approval.json`]: "not json" });
    expect(writeFile(`${ROOT}/src/a.ts`, "x", broken).reason).toMatch(/unreadable/);

    const other = makeContext();
    other.fs = fakeFs({
      [`${ROOT}/PLAN.md`]: "p",
      [`${ROOT}/.agent-guardrails/approval.json`]: JSON.stringify({ version: 1, plan: "OTHER.md", sha256: hashPlan("p") }),
    });
    expect(writeFile(`${ROOT}/src/a.ts`, "x", other).reason).toMatch(/does not match/);

    const missingPlan = makeContext();
    missingPlan.fs = fakeFs({
      [`${ROOT}/.agent-guardrails/approval.json`]: JSON.stringify({ version: 1, plan: "PLAN.md", sha256: hashPlan("p") }),
    });
    expect(writeFile(`${ROOT}/src/a.ts`, "x", missingPlan).reason).toMatch(/does not exist/);
  });

  it("hashes plans the same on every platform", () => {
    expect(hashPlan("a\r\nb")).toBe(hashPlan("a\nb"));
    expect(hashPlan("a")).not.toBe(hashPlan("b"));
  });

  it("supports a custom plan file", () => {
    const ctx = ctxWith({ planFile: "docs/PLAN.md" });
    expect(writeFile(`${ROOT}/docs/PLAN.md`, "x", ctx).decision).toBe("allow");
    expect(writeFile(`${ROOT}/PLAN.md`, "x", ctx).decision).toBe("deny");
  });

  it("also gates shell redirects and write programs", () => {
    expect(shell("echo x > src/out.txt")).toMatchObject({ decision: "deny", rule: "no-approved-plan" });
    expect(shell("echo x > src/out.txt", makeContext({ approved: true })).decision).toBe("allow");
    expect(shell("echo x > PLAN.md").decision).toBe("allow");
    expect(shell("mkdir src/x")).toMatchObject({ decision: "deny", rule: "no-approved-plan" });
  });
});

describe("package scripts", () => {
  const files = {
    [`${ROOT}/package.json`]: JSON.stringify({
      scripts: {
        clean: "rm -rf dist",
        build: "tsc",
        prebuild: "find . -name '*.map' -delete",
        test: "vitest",
        lint: "eslint . && echo done",
        reset: "pnpm clean && pnpm build",
        postinstall: "rm -rf cache",
        prepare: "echo ok",
      },
    }),
    [`${ROOT}/sub/package.json`]: JSON.stringify({ scripts: { clean: "rimraf out", fine: "echo hi" } }),
  };
  const ctx = makeContext({ files });

  it("blocks scripts whose body would be blocked", () => {
    for (const cmd of ["pnpm clean", "npm run clean", "yarn clean", "bun run clean", "pnpm run clean"]) {
      expect(shell(cmd, ctx), cmd).toMatchObject({ decision: "deny", rule: "package-script" });
    }
  });

  it("blocks scripts whose pre/post hook would be blocked", () => {
    expect(shell("pnpm build", ctx)).toMatchObject({ decision: "deny", rule: "package-script" });
  });

  it("blocks install when a lifecycle script would be blocked", () => {
    expect(shell("pnpm install", ctx)).toMatchObject({ decision: "deny", rule: "package-script" });
    expect(shell("npm ci", ctx).rule).toBe("package-script");
  });

  it("lets harmless scripts through to the normal policy", () => {
    expect(shell("pnpm test", ctx)).toMatchObject({ decision: "ask", rule: "unknown-command" });
    expect(shell("pnpm lint", ctx).decision).toBe("ask");
  });

  it("reads the nearest package.json from the working directory", () => {
    const sub = decide({ tool_name: "Bash", tool_input: { command: "pnpm clean" }, cwd: `${ROOT}/sub` }, ctx);
    expect(sub).toMatchObject({ decision: "deny", rule: "package-script" });
    const fine = decide({ tool_name: "Bash", tool_input: { command: "pnpm fine" }, cwd: `${ROOT}/sub` }, ctx);
    expect(fine.decision).toBe("ask");
  });

  it("ignores a missing or broken package.json", () => {
    expect(shell("pnpm build", makeContext()).decision).toBe("ask");
    const broken = makeContext({ files: { [`${ROOT}/package.json`]: "{ nope" } });
    expect(shell("pnpm build", broken).decision).toBe("ask");
  });
});

describe("working directory", () => {
  it("follows cd inside the project", () => {
    const ctx = makeContext({ files: { [`${ROOT}/src/a.ts`]: "x" } });
    expect(shell("cd src && cat a.ts", ctx).decision).toBe("allow");
    expect(shell("cd src && cat ../../x", ctx)).toMatchObject({ decision: "deny", rule: "outside-project" });
    expect(shell("cd src && cat ../.env", ctx)).toMatchObject({ decision: "deny", rule: "secret-file" });
  });

  it("refuses a working directory outside the project", () => {
    expect(decide({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/etc" })).toMatchObject({
      decision: "deny",
      rule: "outside-project",
    });
  });
});

describe("shell lexer", () => {
  const words = (src: string) => lex(src).map((c) => c.words.map((w) => w.v));

  it("splits commands and keeps quoted words together", () => {
    expect(words("ls -la 'a b' \"c d\" e\\ f")).toEqual([["ls", "-la", "a b", "c d", "e f"]]);
    expect(words("a && b || c; d | e & f")).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
    expect(words("a\nb")).toEqual([["a"], ["b"]]);
  });

  it("joins quoted fragments into one word", () => {
    expect(words("r'm' x")).toEqual([["rm", "x"]]);
    expect(words('r""m x')).toEqual([["rm", "x"]]);
    expect(words("\\rm x")).toEqual([["rm", "x"]]);
  });

  it("marks pipes", () => {
    const [a, b] = lex("a | b");
    expect(a?.pipedOut).toBe(true);
    expect(b?.pipedIn).toBe(true);
    expect(lex("a && b")[1]?.pipedIn).toBe(false);
  });

  it("extracts command substitutions and flags dynamic words", () => {
    const cmds = lex("echo $(rm x) `ls`");
    expect(cmds.map((c) => c.words[0]?.v)).toEqual(["rm", "ls", "echo"]);
    expect(cmds[2]?.words[1]?.dyn).toBe(true);
    expect(lex("echo $HOME")[0]?.words[1]).toMatchObject({ v: "$HOME", dyn: true });
    expect(lex("echo '$HOME'")[0]?.words[1]).toMatchObject({ v: "$HOME", dyn: false });
  });

  it("reads redirects and ignores file descriptor numbers", () => {
    const [cmd] = lex("cmd arg 2>&1 > out.txt >> log < in.txt");
    expect(cmd?.words.map((w) => w.v)).toEqual(["cmd", "arg"]);
    expect(cmd?.redirects.map((r) => `${r.op}${r.target.v}`)).toEqual([">&1", ">out.txt", ">>log", "<in.txt"]);
  });

  it("reads here-documents and here-strings", () => {
    const [heredoc] = lex("cat <<EOF\nline1\nline2\nEOF");
    expect(heredoc?.stdinText).toBe("line1\nline2\n");
    const [here] = lex("cat <<< hello");
    expect(here?.stdinText).toBe("hello\n");
    expect(lex("cat <<-EOF\n\tx\n\tEOF")[0]?.stdinText).toBe("\tx\n");
  });

  it("reports what it cannot understand", () => {
    const problems: string[] = [];
    lex("echo 'oops", 0, problems);
    expect(problems).toContain("unterminated-quote");
    const more: string[] = [];
    lex("cat <<EOF\nnever closed", 0, more);
    expect(more).toContain("unterminated-heredoc");
    const arithmetic: string[] = [];
    lex("((x=1))", 0, arithmetic);
    expect(arithmetic).toContain("arithmetic-command");
  });

  it("ignores comments", () => {
    expect(words("ls # rm x")).toEqual([["ls"]]);
    expect(words("echo a#b")).toEqual([["echo", "a#b"]]);
  });

  it("does not hang or crash on odd input", () => {
    for (const input of ["", " ", "\n\n", ";;", "&&", "||", "|", ">", "<<", "$(", "`", "((", "))", "\\", "'", '"', "$", "${", "a $( b", "$(( 1", "x <( y"]) {
      expect(() => lex(input), JSON.stringify(input)).not.toThrow();
    }
    const deep = `${"$(".repeat(30)}ls${")".repeat(30)}`;
    const problems: string[] = [];
    expect(() => lex(deep, 0, problems)).not.toThrow();
    expect(problems).toContain("too-deep");
    expect(shell(deep).decision).not.toBe("allow");
  });
});

describe("request normalization", () => {
  it("understands Claude, Cursor and Codex payloads", () => {
    expect(normalizeRequest({ tool_name: "Bash", tool_input: { command: "ls" } })).toMatchObject({ kind: "shell", command: "ls" });
    expect(normalizeRequest({ tool_name: "Shell", tool_input: { command: "ls" } })).toMatchObject({ kind: "shell" });
    expect(normalizeRequest({ command: "ls", cwd: "/x" })).toMatchObject({ kind: "shell", cwd: "/x" });
    expect(normalizeRequest({ tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } })).toMatchObject({ kind: "patch" });
    expect(normalizeRequest({ tool_name: "Write", tool_input: { file_path: "a" } })).toMatchObject({ kind: "write", paths: ["a"] });
    expect(normalizeRequest({ tool_name: "NotebookEdit", tool_input: { notebook_path: "n" } })).toMatchObject({ kind: "write", paths: ["n"] });
    expect(normalizeRequest({ tool_name: "Read", tool_input: { file_path: "a" } })).toMatchObject({ kind: "read" });
    expect(normalizeRequest({ tool_name: "Delete", tool_input: { file_path: "a" } })).toMatchObject({ kind: "delete" });
    expect(normalizeRequest({ file_path: "a", hook_event_name: "beforeReadFile" })).toMatchObject({ kind: "read" });
    expect(normalizeRequest({ tool_name: "WebFetch", tool_input: {} })).toMatchObject({ kind: "other" });
    expect(normalizeRequest({ workspace_roots: ["/w"], command: "ls" })).toMatchObject({ cwd: "/w" });
  });

  it("reads tool input that arrives as a JSON string", () => {
    expect(normalizeRequest({ tool_name: "Bash", tool_input: '{"command":"ls"}' })).toMatchObject({ kind: "shell", command: "ls" });
  });

  it("collects content from every edit in MultiEdit", () => {
    const req = normalizeRequest({
      tool_name: "MultiEdit",
      tool_input: { file_path: "a.sql", edits: [{ new_string: "SELECT 1" }, { new_string: "DROP TABLE x" }] },
    });
    expect(req).toMatchObject({ kind: "write", content: "SELECT 1\nDROP TABLE x" });
    expect(decide({ tool_name: "MultiEdit", tool_input: { file_path: `${ROOT}/a.sql`, edits: [{ new_string: "DROP TABLE x" }] }, cwd: ROOT }, makeContext({ approved: true })).rule).toBe(
      "destructive-sql-file",
    );
  });
});

describe("answers for each agent", () => {
  const deny: Decision = { decision: "deny", rule: "file-deletion", reason: "rm deletes files." };
  const ask: Decision = { decision: "ask", rule: "unknown-command", reason: "python is unknown." };
  const allow: Decision = { decision: "allow", rule: "allowed", reason: "" };
  const userAllowed: Decision = { decision: "allow", rule: "user-allowed", reason: "" };

  it("Claude Code: exit 2 and stderr to deny, JSON to ask, silence to allow", () => {
    expect(respond("claude", deny)).toMatchObject({ exitCode: 2, stdout: "" });
    expect(respond("claude", deny).stderr).toContain("file-deletion");
    expect(respond("claude", deny).stderr).toContain("Do not retry");

    const asked = respond("claude", ask);
    expect(asked.exitCode).toBe(0);
    expect(JSON.parse(asked.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("approval") },
    });

    expect(respond("claude", allow)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(JSON.parse(respond("claude", userAllowed).stdout).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("Cursor: always answers with JSON, and exit 2 only for deny", () => {
    expect(JSON.parse(respond("cursor", allow).stdout)).toEqual({ permission: "allow" });
    expect(respond("cursor", allow).exitCode).toBe(0);

    const asked = respond("cursor", ask);
    expect(asked.exitCode).toBe(0);
    expect(JSON.parse(asked.stdout)).toMatchObject({ permission: "ask", user_message: expect.any(String), agent_message: expect.any(String) });

    const denied = respond("cursor", deny);
    expect(denied.exitCode).toBe(2);
    expect(JSON.parse(denied.stdout)).toMatchObject({ permission: "deny" });
  });

  it("Codex: cannot ask, so an ask becomes a deny that says to ask in chat", () => {
    const asked = respond("codex", ask);
    expect(asked.exitCode).toBe(2);
    expect(asked.stderr).toMatch(/Codex cannot prompt/);
    expect(respond("codex", deny).exitCode).toBe(2);
    expect(respond("codex", allow)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(respond("codex", userAllowed)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });
});

describe("runGuard (fails closed)", () => {
  const run = (stdin: string, extra: Record<string, unknown> = {}, files: Record<string, string> = {}) => {
    const fsImpl = fakeFs(files);
    return { out: runGuard({ stdin, argv: ["--agent", "claude"], scriptDir: `${ROOT}/.agent-guardrails`, fsImpl, home: "/home/tester", ...extra }), fsImpl };
  };
  const bash = (command: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: ROOT });

  it("denies empty input, bad JSON and garbage", () => {
    expect(run("").out.exitCode).toBe(2);
    expect(run("   \n").out.exitCode).toBe(2);
    expect(run("{not json").out.exitCode).toBe(2);
    expect(run("{}").out.exitCode).toBe(2);
    expect(run("null").out.exitCode).toBe(2);
    expect(run("[]").out.exitCode).toBe(2);
  });

  it("denies when the config is broken", () => {
    const bad = run(bash("ls"), {}, { [`${ROOT}/agent-guardrails.config.json`]: "{ nope" });
    expect(bad.out.exitCode).toBe(2);
    expect(bad.out.stderr).toMatch(/bad-config/);

    for (const config of [
      { policy: "yolo" },
      { allowCommands: "pnpm test" },
      { allowCommands: [""] },
      { allowCommands: ["*"] },
      { allowCommands: ["* test"] },
      { gitAllow: [1] },
      { approvalGate: "yes" },
      { planFile: "" },
      { version: 2 },
      [],
    ]) {
      const result = run(bash("ls"), {}, { [`${ROOT}/agent-guardrails.config.json`]: JSON.stringify(config) });
      expect(result.out.exitCode, JSON.stringify(config)).toBe(2);
      expect(result.out.stderr).toMatch(/bad-config/);
    }
  });

  it("reads a valid config", () => {
    const result = run(bash("pnpm test"), {}, { [`${ROOT}/agent-guardrails.config.json`]: JSON.stringify({ allowCommands: ["pnpm test"] }) });
    expect(result.out.exitCode).toBe(0);
    expect(JSON.parse(result.out.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("fails closed if anything inside crashes", () => {
    const fsImpl = fakeFs();
    fsImpl.existsSync = () => {
      throw new Error("disk on fire");
    };
    const out = runGuard({ stdin: bash("ls"), argv: ["--agent", "claude"], scriptDir: `${ROOT}/.agent-guardrails`, fsImpl });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toMatch(/guard-error/);
  });

  it("fails closed when it cannot tell where the project is", () => {
    expect(runGuard({ stdin: bash("ls"), argv: ["--agent", "claude"], fsImpl: fakeFs() }).exitCode).toBe(2);
  });

  it("records denials and asks in the audit log, and allows only on request", () => {
    const denied = run(bash("rm x"));
    expect(denied.fsImpl.appended).toHaveLength(1);
    expect(JSON.parse(denied.fsImpl.appended[0] ?? "")).toMatchObject({ agent: "claude", decision: "deny", rule: "file-deletion", detail: "rm x" });

    const asked = run(bash("python script.py"));
    expect(JSON.parse(asked.fsImpl.appended[0] ?? "")).toMatchObject({ decision: "ask" });

    expect(run(bash("ls")).fsImpl.appended).toHaveLength(0);
    const loud = run(bash("ls"), {}, { [`${ROOT}/agent-guardrails.config.json`]: JSON.stringify({ auditAllowed: true }) });
    expect(loud.fsImpl.appended).toHaveLength(1);

    expect(run(bash("rm x"), { audit: false }).fsImpl.appended).toHaveLength(0);
  });

  it("truncates very long commands in the audit log", () => {
    const long = `echo ${"a".repeat(1000)} > /etc/x`;
    const entry = JSON.parse(run(bash(long)).fsImpl.appended[0] ?? "{}") as { detail: string };
    expect(entry.detail.length).toBe(300);
  });

  it("infers Cursor from the payload when no --agent flag is given", () => {
    const out = runGuard({ stdin: JSON.stringify({ command: "ls", cwd: ROOT }), argv: [], scriptDir: `${ROOT}/.agent-guardrails`, fsImpl: fakeFs() });
    expect(JSON.parse(out.stdout)).toEqual({ permission: "allow" });
  });
});

describe("config", () => {
  it("keeps the guard's defaults identical to the TypeScript schema's (for the keys the guard reads)", () => {
    const picked = Object.fromEntries(GUARD_CONFIG_KEYS.map((key) => [key, TS_DEFAULT_CONFIG[key]]));
    expect(DEFAULT_CONFIG).toEqual(picked);
  });

  it("lets the guard ignore the CLI-only keys", () => {
    const checked = validateConfig({ policy: "ask", agents: ["claude"], preset: "team", stack: "go", alwaysRuleFiles: true, github: false });
    expect(checked.error).toBeUndefined();
    expect(checked.config?.policy).toBe("ask");
  });

  it("validates exactly like the TypeScript schema", () => {
    const samples: unknown[] = [
      {},
      { policy: "ask" },
      { policy: "blocklist", allowCommands: ["pnpm test"], gitAllow: ["status"], approvalGate: false, planFile: "X.md", auditAllowed: true },
      { policy: "nope" },
      { allowCommands: ["*"] },
      { allowCommands: ["* x"] },
      { allowCommands: [" pnpm test "] },
      { allowCommands: [""] },
      { gitAllow: [] },
      { approvalGate: 1 },
      { version: 1 },
      { version: 2 },
      { unknown: true },
    ];
    for (const sample of samples) {
      const guardOk = validateConfig(sample).config !== undefined;
      let tsOk = true;
      try {
        parseConfig(JSON.stringify(sample));
      } catch {
        tsOk = false;
      }
      expect(guardOk, JSON.stringify(sample)).toBe(tsOk);
    }
  });

  it("trims allow patterns the same way in both", () => {
    const sample = { allowCommands: ["  pnpm test  "] };
    expect(validateConfig(sample).config?.allowCommands).toEqual(parseConfig(JSON.stringify(sample)).allowCommands);
  });
});
