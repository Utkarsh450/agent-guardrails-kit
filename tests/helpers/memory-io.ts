import type { SyncIo } from "../../src/features/rules/sync.ts";

/** In-memory stand-in for the project folder, so tests never touch the real disk. */
export interface MemoryIo extends SyncIo {
  files: Map<string, string>;
  symlinks: Set<string>;
}

export function memoryIo(
  initial: Record<string, string> = {},
  symlinks: readonly string[] = [],
): MemoryIo {
  const files = new Map(Object.entries(initial));
  const links = new Set(symlinks);

  return {
    files,
    symlinks: links,
    async readExisting(rel) {
      if (links.has(rel)) return { kind: "symlink", content: "" };
      const content = files.get(rel);
      if (content !== undefined) return { kind: "file", content };
      // Like the real disk reader, a folder that holds files exists and is "other" (not a regular file).
      const prefix = `${rel}/`;
      return [...files.keys()].some((key) => key.startsWith(prefix)) ? { kind: "other", content: "" } : null;
    },
    async listFiles(relDir) {
      const prefix = `${relDir}/`;
      return [...files.keys()]
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
        .map((key) => key.slice(prefix.length))
        .sort();
    },
  };
}
