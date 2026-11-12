import { describe, expect, it } from "vitest";
import { ROOT, shell } from "../../../../tests/helpers/guard-ctx.ts";
import { fakeFs, makeContext } from "../sandbox.ts";
import { runGuard, validateConfig, watchActive } from "./guard.mjs";

const NOW = new Date("2026-11-07T09:00:00.000Z");
const DAY = 86_400_000;
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();
const bash = (command: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: ROOT });
const mcp = (tool: string) => JSON.stringify({ tool_name: tool, tool_input: {}, cwd: ROOT });
const watching = { mode: "watch", watchUntil: inDays(7) };

function run(stdin: string, config: Record<string, unknown>, agent = "claude") {
  const fsImpl = fakeFs({ [`${ROOT}/agent-guardrails.config.json`]: JSON.stringify({ version: 1, ...config }) });
  const out = runGuard({ stdin, argv: ["--agent", agent], scriptDir: `${ROOT}/.agent-guardrails`, fsImpl, home: "/home/tester", now: NOW });
  const logged = fsImpl.appended.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { out, logged };
}

describe("watch mode in the guard", () => {
  it("asks as usual when watch mode is off", () => {
    const { out, logged } = run(bash("python script.py"), {});
    expect(out.stdout).toContain('"permissionDecision":"ask"');
    expect(logged[0]).toMatchObject({ decision: "ask", rule: "unknown-command" });
    expect(logged[0]).not.toHaveProperty("watched");
  });

  it("lets an ask run and records it as what it was, flagged watched", () => {
    const { out, logged } = run(bash("python script.py"), watching);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ decision: "ask", rule: "unknown-command", watched: true });
  });

  it("answers Cursor with an explicit allow", () => {
    const { out } = run(bash("python script.py"), watching, "cursor");
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ permission: "allow" });
  });

  it("never softens a block", () => {
    for (const command of ["rm -rf build", "git push origin main", "gh pr create", "cat .env", "sudo ls"]) {
      const { out, logged } = run(bash(command), watching);
      expect(out.exitCode, command).toBe(2);
      expect(logged[0], command).toMatchObject({ decision: "deny" });
      expect(logged[0], command).not.toHaveProperty("watched");
    }
  });

  it("keeps asking about MCP tools that act, and lets reads through", () => {
    const act = run(mcp("mcp__crm__delete_contact"), watching);
    expect(act.out.stdout).toContain('"permissionDecision":"ask"');
    expect(act.logged[0]).toMatchObject({ rule: "mcp-action" });
    expect(act.logged[0]).not.toHaveProperty("watched");

    const read = run(mcp("mcp__crm__get_contact"), watching);
    expect(read.out.exitCode).toBe(0);
    expect(read.out.stdout).toBe("");
  });

  it("enforces again once the end date has passed", () => {
    const { out, logged } = run(bash("python script.py"), { mode: "watch", watchUntil: inDays(-1) });
    expect(out.stdout).toContain('"permissionDecision":"ask"');
    expect(logged[0]).not.toHaveProperty("watched");
  });

  it("enforces when watch mode has no end date", () => {
    expect(run(bash("python script.py"), { mode: "watch" }).out.stdout).toContain('"permissionDecision":"ask"');
    expect(run(bash("python script.py"), { mode: "watch", watchUntil: null }).out.stdout).toContain('"permissionDecision":"ask"');
  });

  it("enforces when the end date is more than 30 days away", () => {
    expect(run(bash("python script.py"), { mode: "watch", watchUntil: inDays(31) }).out.stdout).toContain('"permissionDecision":"ask"');
    expect(run(bash("python script.py"), { mode: "watch", watchUntil: inDays(29) }).out.exitCode).toBe(0);
  });

  it("denies when the new settings are invalid", () => {
    for (const config of [{ mode: "dry-run" }, { mode: "watch", watchUntil: "tomorrow" }, { watchUntil: 5 }]) {
      const { out } = run(bash("ls"), config);
      expect(out.exitCode, JSON.stringify(config)).toBe(2);
      expect(out.stderr).toMatch(/bad-config/);
    }
  });

  it("is not seen by the plain decision function the self-test uses", () => {
    const ctx = makeContext({ config: { mode: "watch", watchUntil: inDays(7) } });
    expect(shell("python script.py", ctx)).toMatchObject({ decision: "ask", rule: "unknown-command" });
  });

  it("stops agents from running the mode command", () => {
    expect(shell("agent-guardrails-kit mode watch --days 7")).toMatchObject({ decision: "deny", rule: "guardrails-cli" });
    expect(shell("npx agent-guardrails-kit mode enforce")).toMatchObject({ decision: "deny", rule: "guardrails-cli" });
    expect(shell("agent-guardrails-kit alerts --notify")).toMatchObject({ decision: "deny", rule: "guardrails-cli" });
    expect(shell("agent-guardrails-kit restore 20261107T101000000Z-aaaa --yes")).toMatchObject({ decision: "deny", rule: "guardrails-cli" });
    expect(shell("agent-guardrails-kit checkpoints").decision).not.toBe("deny");
    expect(shell("agent-guardrails-kit preset use ./team.json --yes")).toMatchObject({ decision: "deny", rule: "guardrails-cli" });
    expect(shell("agent-guardrails-kit preset export team.json --yes")).toMatchObject({ decision: "deny", rule: "guardrails-cli" });
  });
});

describe("watchActive", () => {
  it("is true only for watch mode with an end date in the next 30 days", () => {
    expect(watchActive({ mode: "watch", watchUntil: inDays(1) }, NOW)).toBe(true);
    expect(watchActive({ mode: "watch", watchUntil: inDays(30) }, NOW)).toBe(true);
    expect(watchActive({ mode: "watch", watchUntil: inDays(30.01) }, NOW)).toBe(false);
    expect(watchActive({ mode: "watch", watchUntil: NOW.toISOString() }, NOW)).toBe(false);
    expect(watchActive({ mode: "watch", watchUntil: inDays(-3) }, NOW)).toBe(false);
    expect(watchActive({ mode: "watch", watchUntil: null }, NOW)).toBe(false);
    expect(watchActive({ mode: "watch", watchUntil: "not a date" }, NOW)).toBe(false);
    expect(watchActive({ mode: "enforce", watchUntil: inDays(3) }, NOW)).toBe(false);
  });
});

describe("validateConfig for watch settings", () => {
  it("defaults to enforce with no end date", () => {
    expect(validateConfig({}).config).toMatchObject({ mode: "enforce", watchUntil: null });
  });

  it("accepts watch with an end date", () => {
    expect(validateConfig({ mode: "watch", watchUntil: inDays(7) }).config).toMatchObject({ mode: "watch", watchUntil: inDays(7) });
    expect(validateConfig({ mode: "enforce", watchUntil: null }).error).toBeUndefined();
  });

  it("rejects unknown modes and bad dates", () => {
    expect(validateConfig({ mode: "off" }).error).toMatch(/mode must be one of/);
    expect(validateConfig({ watchUntil: "soon" }).error).toMatch(/watchUntil/);
    expect(validateConfig({ watchUntil: 123 }).error).toMatch(/watchUntil/);
  });
});
