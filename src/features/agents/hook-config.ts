import { ensureArray, ensureObject, isObject, type JsonObject } from "../../shared/json-config.ts";
import { GUARD_MARKER } from "./constants.ts";

/** One command hook in the format shared by Claude Code, Codex and Qoder. */
export interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}

export interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

function isOurs(hook: unknown): boolean {
  return isObject(hook) && typeof hook.command === "string" && hook.command.includes(GUARD_MARKER);
}

/**
 * Installs the kit's hook groups under hooks.<event> (Claude Code / Codex / Qoder shape).
 * Groups made only of our hooks are replaced in place; our hooks inside a group shared with the user's own
 * hooks are removed from it; anything of ours that is still missing is appended. Other hooks are untouched.
 */
export function upsertHookGroups(config: JsonObject, event: string, groups: readonly HookGroup[]): void {
  const hooks = ensureObject(config, "hooks", "settings");
  const list = ensureArray(hooks, event, "hooks");
  const pending = [...groups];
  const result: unknown[] = [];

  for (const group of list) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      result.push(group);
      continue;
    }
    const mine = group.hooks.filter(isOurs);
    if (mine.length === 0) {
      result.push(group);
      continue;
    }
    const others = group.hooks.filter((hook) => !isOurs(hook));
    if (others.length === 0) {
      const next = pending.shift();
      if (next) result.push(next);
    } else {
      result.push({ ...group, hooks: others });
    }
  }
  result.push(...pending);

  list.length = 0;
  list.push(...result);
}

/** Cursor's shape: hooks.<event> is a flat list of { command, matcher?, failClosed? }. */
export interface CursorHook {
  command: string;
  matcher?: string;
  failClosed?: boolean;
}

export function upsertCursorHook(config: JsonObject, event: string, entry: CursorHook): void {
  if (config.version === undefined) config.version = 1;
  const hooks = ensureObject(config, "hooks", "hooks.json");
  const list = ensureArray(hooks, event, "hooks");
  const index = list.findIndex((item) => isObject(item) && typeof item.command === "string" && item.command.includes(GUARD_MARKER));
  if (index >= 0) list[index] = entry;
  else list.push(entry);
}
