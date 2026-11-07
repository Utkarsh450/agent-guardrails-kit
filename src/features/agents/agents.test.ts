import { describe, expect, it } from "vitest";
import { AGENT_IDS, type AgentId } from "../../shared/agents.ts";
import type { PlannedFile, ReadExisting } from "../../shared/fs-plan.ts";
import { memoryIo, type MemoryIo } from "../../../tests/helpers/memory-io.ts";
import { GUARD_MARKER, commands, matchers } from "./constants.ts";
import { detectAgents } from "./detect.ts";
import { ENFORCEMENT, planAgents } from "./plan.ts";
import { planAntigravity, antigravityPermissionsSnippet } from "./antigravity.ts";
import { planClaude } from "./claude.ts";
import { planCodex } from "./codex.ts";
import { planCursor } from "./cursor.ts";
import { planQoder } from "./qoder.ts";

const json = (plan: PlannedFile) => JSON.parse(plan.content) as Record<string, any>;

/** Writes planned creates/updates into the in-memory project, as `init` would. */
function apply(io: MemoryIo, files: readonly PlannedFile[]): void {
  for (const file of files) if (file.status === "create" || file.status === "update") io.files.set(file.path, file.content);
}

describe("Claude Code", () => {
  it("adds a fail-closed PreToolUse hook and deny rules to a new settings file", async () => {
    const { files, enforcement } = await planClaude(memoryIo().readExisting);
    expect(enforcement).toBe("enforced");
    const [file] = files;
    expect(file).toMatchObject({ path: ".claude/settings.json", status: "create" });

    const settings = json(file!);
    const groups = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>;
    expect(groups.map((g) => g.matcher)).toEqual([matchers.claude, matchers.claudeMcp]);
    for (const group of groups) {
      expect(group.hooks).toEqual([{ type: "command", command: commands.claude, timeout: 30 }]);
    }
    expect(commands.claude).toContain("|| exit 2");
    expect(commands.claude).toContain("$CLAUDE_PROJECT_DIR");
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Bash(rm *)", "Bash(git push *)", "Bash(gh *)", "Read(./.env)"]));
  });

  it("does not use the onFailure key that older Claude Code versions may not understand", async () => {
    const { files } = await planClaude(memoryIo().readExisting);
    expect(files[0]?.content).not.toContain("onFailure");
  });

  it("keeps the user's own hooks, rules and settings", async () => {
    const mine = {
      model: "opus",
      permissions: { allow: ["Bash(pnpm test)"], deny: ["Read(./secrets/**)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter.sh" }] }],
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier.sh" }] }],
      },
    };
    const io = memoryIo({ ".claude/settings.json": JSON.stringify(mine, null, 2) });
    const settings = json((await planClaude(io.readExisting)).files[0]!);

    expect(settings.model).toBe("opus");
    expect(settings.permissions.allow).toEqual(["Bash(pnpm test)"]);
    expect(settings.permissions.deny[0]).toBe("Read(./secrets/**)");
    expect(settings.permissions.deny).toContain("Bash(rm *)");
    expect(settings.hooks.PostToolUse).toEqual(mine.hooks.PostToolUse);
    expect(settings.hooks.PreToolUse[0]).toEqual(mine.hooks.PreToolUse[0]);
    expect(settings.hooks.PreToolUse).toHaveLength(3);
  });

  it("is idempotent and refreshes its own entries instead of duplicating them", async () => {
    const io = memoryIo({ ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x.sh" }] }] } }) });
    const first = await planClaude(io.readExisting);
    apply(io, first.files);
    const second = await planClaude(io.readExisting);
    expect(second.files[0]?.status).toBe("unchanged");

    // A stale copy of our hook (old command text) is replaced in place.
    const stale = json(first.files[0]!);
    stale.hooks.PreToolUse[1].hooks[0].command = `node "${GUARD_MARKER}" --agent claude`;
    io.files.set(".claude/settings.json", JSON.stringify(stale));
    const healed = json((await planClaude(io.readExisting)).files[0]!);
    expect(healed.hooks.PreToolUse).toHaveLength(3);
    expect(healed.hooks.PreToolUse[1].hooks[0].command).toBe(commands.claude);
  });

  it("removes only its own hook from a group it shares with the user's hook", async () => {
    const shared = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "my-linter.sh" },
              { type: "command", command: `node "$CLAUDE_PROJECT_DIR/${GUARD_MARKER}" --agent claude` },
            ],
          },
        ],
      },
    };
    const io = memoryIo({ ".claude/settings.json": JSON.stringify(shared) });
    const settings = json((await planClaude(io.readExisting)).files[0]!);
    expect(settings.hooks.PreToolUse[0]).toEqual({ matcher: "Bash", hooks: [{ type: "command", command: "my-linter.sh" }] });
    expect(settings.hooks.PreToolUse).toHaveLength(3);
  });

  it("leaves a settings file it cannot understand alone", async () => {
    const bad = await planClaude(memoryIo({ ".claude/settings.json": "{ // comment\n}" }).readExisting);
    expect(bad.files[0]?.status).toBe("conflict");
    const wrongShape = await planClaude(memoryIo({ ".claude/settings.json": '{"hooks":{"PreToolUse":"x"}}' }).readExisting);
    expect(wrongShape.files[0]?.status).toBe("conflict");
    expect(wrongShape.files[0]?.reason).toMatch(/not a JSON array/);
  });
});

describe("Cursor", () => {
  it("hooks shell commands and tool calls, failing closed", async () => {
    const { files } = await planCursor(memoryIo().readExisting);
    const config = json(files[0]!);
    expect(files[0]?.path).toBe(".cursor/hooks.json");
    expect(config.version).toBe(1);
    expect(config.hooks.beforeShellExecution).toEqual([{ command: commands.cursor, failClosed: true }]);
    expect(config.hooks.preToolUse).toEqual([{ command: commands.cursor, matcher: matchers.cursorTools, failClosed: true }]);
    expect(commands.cursor).toBe("node .agent-guardrails/guard.mjs --agent cursor");
  });

  it("keeps the user's hooks and version, and is idempotent", async () => {
    const mine = { version: 1, hooks: { afterFileEdit: [{ command: "fmt.sh" }], beforeShellExecution: [{ command: "audit.sh" }] } };
    const io = memoryIo({ ".cursor/hooks.json": JSON.stringify(mine) });
    const first = await planCursor(io.readExisting);
    const config = json(first.files[0]!);
    expect(config.hooks.afterFileEdit).toEqual([{ command: "fmt.sh" }]);
    expect(config.hooks.beforeShellExecution).toHaveLength(2);
    expect(config.hooks.beforeShellExecution[0]).toEqual({ command: "audit.sh" });
    apply(io, first.files);
    expect((await planCursor(io.readExisting)).files[0]?.status).toBe("unchanged");
  });
});

describe("Codex", () => {
  it("hooks Bash, apply_patch and MCP tools", async () => {
    const plan = await planCodex(memoryIo().readExisting);
    const config = json(plan.files[0]!);
    expect(plan.files[0]?.path).toBe(".codex/hooks.json");
    expect(config.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash|apply_patch|mcp__.*",
        hooks: [{ type: "command", command: commands.codex, timeout: 30, statusMessage: expect.any(String) }],
      },
    ]);
    expect(commands.codex).toContain("|| exit 2");
  });

  it("tells the user the steps only they can do", async () => {
    const { notes } = await planCodex(memoryIo().readExisting);
    const text = notes.join("\n");
    expect(text).toMatch(/\/hooks/);
    expect(text).toMatch(/trust/i);
    expect(text).toMatch(/sandbox_mode/);
    expect(text).toMatch(/cannot ask/);
  });
});

describe("Qoder", () => {
  it("installs Claude-style hooks with Qoder's project variable and its own deny syntax", async () => {
    const plan = await planQoder(memoryIo().readExisting);
    expect(plan.enforcement).toBe("enforced");
    const config = json(plan.files[0]!);
    expect(plan.files[0]?.path).toBe(".qoder/settings.json");
    expect(config.hooks.PreToolUse).toHaveLength(2);
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe(commands.qoder);
    expect(commands.qoder).toContain("$QODER_PROJECT_DIR");
    expect(commands.qoder).toContain("--agent qoder");
    expect(config.permissions.deny).toEqual(expect.arrayContaining(["Bash(rm:*)", "Bash(git push:*)", "Read(.env)"]));
  });
});

describe("Antigravity", () => {
  it("is advisory, writes no project config and hands over a permissions snippet", () => {
    const plan = planAntigravity();
    expect(plan.enforcement).toBe("advisory");
    expect(plan.files).toEqual([]);
    const snippet = JSON.parse(antigravityPermissionsSnippet()) as { permissions: { deny: string[]; allow: string[]; ask: string[] } };
    expect(snippet.permissions.deny).toEqual(expect.arrayContaining(["command(rm)", "command(git push)", "command(gh)", "read_file(.env)"]));
    expect(snippet.permissions.allow).toEqual(expect.arrayContaining(["command(git status)"]));
    expect(plan.notes.join("\n")).toContain("~/.gemini/antigravity-cli/settings.json");
    expect(plan.notes.join("\n")).toMatch(/no hooks/);
  });
});

describe("planAgents", () => {
  it("plans every agent, in the order asked", async () => {
    const plans = await planAgents(memoryIo().readExisting, AGENT_IDS);
    expect(plans.map((plan) => plan.agent)).toEqual([...AGENT_IDS]);
    for (const plan of plans) expect(plan.enforcement).toBe(ENFORCEMENT[plan.agent]);
  });

  it("says which agents can really block actions", () => {
    const enforced = (Object.keys(ENFORCEMENT) as AgentId[]).filter((id) => ENFORCEMENT[id] === "enforced");
    expect(enforced.sort()).toEqual(["claude", "codex", "cursor", "qoder"]);
    expect(ENFORCEMENT.antigravity).toBe("advisory");
  });

  it("never plans a write outside the project", async () => {
    const plans = await planAgents(memoryIo().readExisting, AGENT_IDS);
    for (const file of plans.flatMap((plan) => plan.files)) {
      expect(file.path.startsWith("/") || file.path.startsWith("..") || file.path.startsWith("~")).toBe(false);
    }
  });
});

describe("detectAgents", () => {
  const detect = (files: Record<string, string>) => detectAgents(memoryIo(files).readExisting);

  it("finds each agent by its footprint", async () => {
    const found = await detect({ "CLAUDE.md": "x", ".cursor/rules/a.mdc": "x", ".codex/config.toml": "x", ".qoder/rules/a.md": "x", "GEMINI.md": "x" });
    expect(found.map((f) => f.agent).sort()).toEqual(["antigravity", "claude", "codex", "cursor", "qoder"]);
  });

  it("reports what it saw and finds nothing in an empty project", async () => {
    expect(await detect({})).toEqual([]);
    const found = await detect({ ".claude/settings.json": "{}", "CLAUDE.md": "x" });
    expect(found).toEqual([{ agent: "claude", evidence: [".claude", "CLAUDE.md"] }]);
  });

  it("does not guess from AGENTS.md alone, which several agents share", async () => {
    expect(await detect({ "AGENTS.md": "x" })).toEqual([]);
  });
});

// Type check: the reader type is exactly what the planners accept.
const _typecheck: ReadExisting = memoryIo().readExisting;
void _typecheck;
