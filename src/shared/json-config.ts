import type { PlannedFile, ReadExisting } from "./fs-plan.ts";
import { normalizeRelPath } from "./fs-plan.ts";

/**
 * Edits a JSON config file that belongs to the user (for example .claude/settings.json) without
 * overwriting it: the file is read, only the kit's own entries are added or refreshed, everything else
 * is kept, and the result is planned like any other write (create / update / unchanged / conflict).
 */

export type JsonObject = Record<string, unknown>;

export class MergeError extends Error {
  override name = "MergeError";
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detectIndent(text: string): string {
  const match = /^([ \t]+)"/m.exec(text);
  if (!match) return "  ";
  const indent = match[1] ?? "  ";
  return indent.includes("\t") ? "\t" : indent;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function serializeJson(value: JsonObject, indent = "  "): string {
  return `${JSON.stringify(value, null, indent)}\n`;
}

/** Plans an edit to a JSON config file. `transform` receives a copy and returns the new object. */
export async function planJsonConfig(
  relPath: string,
  readExisting: ReadExisting,
  transform: (config: JsonObject) => JsonObject,
): Promise<PlannedFile> {
  const rel = normalizeRelPath(relPath);
  const existing = await readExisting(rel);
  const base = { path: rel, generated: false };

  const conflict = (reason: string, current: string | null = null): PlannedFile => ({
    ...base,
    content: "",
    status: "conflict",
    existing: current,
    reason,
  });

  if (existing !== null && existing.kind === "symlink") {
    return conflict("is a symlink; the kit never writes through symlinks");
  }
  if (existing !== null && existing.kind === "other") return conflict("exists and is not a regular file");

  let current: JsonObject = {};
  let indent = "  ";
  if (existing !== null) {
    const text = stripBom(existing.content);
    if (text.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return conflict(
          `is not valid JSON (${detail}). Comments and trailing commas are not allowed; fix the file or move it aside`,
          existing.content,
        );
      }
      if (!isObject(parsed)) return conflict("does not hold a JSON object at the top level", existing.content);
      current = parsed;
      indent = detectIndent(text);
    }
  }

  let next: JsonObject;
  try {
    next = transform(structuredClone(current));
  } catch (error) {
    if (error instanceof MergeError) return conflict(error.message, existing?.content ?? null);
    throw error;
  }

  const content = serializeJson(next, indent);
  if (existing === null) return { ...base, content, status: "create", existing: null, reason: null };
  if (stripBom(existing.content) === content) {
    return { ...base, content, status: "unchanged", existing: existing.content, reason: null };
  }
  return { ...base, content, status: "update", existing: existing.content, reason: null };
}

/** Returns config[key] as an object, creating it when missing. Throws MergeError when it has another type. */
export function ensureObject(parent: JsonObject, key: string, where: string): JsonObject {
  const value = parent[key];
  if (value === undefined) {
    const created: JsonObject = {};
    parent[key] = created;
    return created;
  }
  if (!isObject(value)) throw new MergeError(`${where}.${key} is not a JSON object`);
  return value;
}

export function ensureArray(parent: JsonObject, key: string, where: string): unknown[] {
  const value = parent[key];
  if (value === undefined) {
    const created: unknown[] = [];
    parent[key] = created;
    return created;
  }
  if (!Array.isArray(value)) throw new MergeError(`${where}.${key} is not a JSON array`);
  return value;
}

/** Adds missing strings to a list, keeping the user's entries and their order. */
export function addToStringList(parent: JsonObject, key: string, where: string, values: readonly string[]): void {
  const list = ensureArray(parent, key, where);
  for (const value of values) {
    if (!list.includes(value)) list.push(value);
  }
}
