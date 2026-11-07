import type { ReadExisting } from "../../shared/fs-plan.ts";
import { planJsonConfig } from "../../shared/json-config.ts";
import { commands, matchers } from "./constants.ts";
import { upsertCursorHook } from "./hook-config.ts";
import type { AgentPlan } from "./types.ts";

export const CURSOR_HOOKS = ".cursor/hooks.json";

/** Cursor: shell commands and tool calls both go through the guard, with failClosed so a broken guard blocks. */
export async function planCursor(read: ReadExisting): Promise<AgentPlan> {
  const file = await planJsonConfig(CURSOR_HOOKS, read, (config) => {
    upsertCursorHook(config, "beforeShellExecution", { command: commands.cursor, failClosed: true });
    upsertCursorHook(config, "preToolUse", { command: commands.cursor, matcher: matchers.cursorTools, failClosed: true });
    return config;
  });

  return {
    agent: "cursor",
    enforcement: "enforced",
    files: [file],
    notes: [
      "Restart Cursor or reload the window so it picks up .cursor/hooks.json. Project hooks run in trusted workspaces.",
      "Cursor reads AGENTS.md itself, so the always-on rules are not repeated in .cursor/rules (only scoped rules are).",
    ],
  };
}
