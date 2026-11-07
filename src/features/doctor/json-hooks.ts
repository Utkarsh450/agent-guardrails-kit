import { GUARD_MARKER } from "../agents/index.ts";
import type { ReadExisting } from "../../shared/fs-plan.ts";

export type JsonRead =
  | { state: "missing" }
  | { state: "invalid"; error: string }
  | { state: "ok"; data: Record<string, unknown> };

/** Reads a JSON config file the way the agents would: it must be a JSON object. */
export async function readJsonObject(read: ReadExisting, rel: string): Promise<JsonRead> {
  const file = await read(rel);
  if (file === null) return { state: "missing" };
  if (file.kind !== "file") return { state: "invalid", error: "is not a regular file" };
  try {
    const data: unknown = JSON.parse(file.content.replace(/^﻿/, ""));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return { state: "invalid", error: "does not hold a JSON object" };
    return { state: "ok", data: data as Record<string, unknown> };
  } catch (error) {
    return { state: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

export interface FoundHook {
  command: string;
  matcher: string | undefined;
  failClosed: boolean | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Our hooks under hooks.<event> in the Claude Code / Codex / Qoder shape (matcher groups). */
export function groupedHooks(config: Record<string, unknown>, event: string): FoundHook[] {
  const hooks = config.hooks;
  if (!isObject(hooks) || !Array.isArray(hooks[event])) return [];
  const found: FoundHook[] = [];
  for (const group of hooks[event] as unknown[]) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks as unknown[]) {
      if (isObject(hook) && typeof hook.command === "string" && hook.command.includes(GUARD_MARKER)) {
        found.push({ command: hook.command, matcher: typeof group.matcher === "string" ? group.matcher : undefined, failClosed: undefined });
      }
    }
  }
  return found;
}

/** Our hooks under hooks.<event> in Cursor's flat shape. */
export function flatHooks(config: Record<string, unknown>, event: string): FoundHook[] {
  const hooks = config.hooks;
  if (!isObject(hooks) || !Array.isArray(hooks[event])) return [];
  return (hooks[event] as unknown[])
    .filter((item): item is Record<string, unknown> => isObject(item) && typeof item.command === "string" && item.command.includes(GUARD_MARKER))
    .map((item) => ({
      command: item.command as string,
      matcher: typeof item.matcher === "string" ? item.matcher : undefined,
      failClosed: typeof item.failClosed === "boolean" ? item.failClosed : undefined,
    }));
}
