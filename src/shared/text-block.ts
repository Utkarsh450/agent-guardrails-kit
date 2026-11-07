import { normalizeRelPath, type PlannedFile, type ReadExisting } from "./fs-plan.ts";

/**
 * Keeps a block of lines inside a user-owned text file (like .gitignore) between two marker lines.
 * Everything outside the markers is left exactly as the user wrote it. Rerunning refreshes only the block.
 */

export function blockMarkers(id: string): { begin: string; end: string } {
  return {
    begin: `# >>> agent-guardrails:${id} (managed block; edit outside it)`,
    end: `# <<< agent-guardrails:${id}`,
  };
}

export function renderBlock(id: string, lines: readonly string[]): string {
  const { begin, end } = blockMarkers(id);
  return [begin, ...lines, end].join("\n");
}

export interface Block {
  id: string;
  lines: readonly string[];
}

type Applied = { text: string } | { conflict: string };

/** Puts one block into `text`: refreshes it in place when present, appends it when not. */
function applyBlock(text: string, id: string, lines: readonly string[]): Applied {
  const block = renderBlock(id, lines);
  const { begin, end } = blockMarkers(id);
  const first = text.indexOf(begin);

  if (first < 0) {
    const gap = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return { text: `${text}${gap}${block}\n` };
  }
  if (text.indexOf(begin, first + begin.length) >= 0) {
    return { conflict: `has the "${id}" block more than once; remove the extra copy by hand` };
  }
  const last = text.indexOf(end, first);
  if (last < 0) return { conflict: `has the start of the "${id}" block but not its end marker` };
  return { text: `${text.slice(0, first)}${block}${text.slice(last + end.length)}` };
}

/** Plans one edit that puts several managed blocks into the same file. */
export async function planTextBlocks(
  relPath: string,
  blocks: readonly Block[],
  readExisting: ReadExisting,
): Promise<PlannedFile> {
  const rel = normalizeRelPath(relPath);
  const base = { path: rel, generated: false };
  const existing = await readExisting(rel);

  const conflict = (reason: string, current: string | null = null): PlannedFile => ({
    ...base,
    content: "",
    status: "conflict",
    existing: current,
    reason,
  });

  if (existing !== null && existing.kind === "symlink") return conflict("is a symlink; the kit never writes through symlinks");
  if (existing !== null && existing.kind === "other") return conflict("exists and is not a regular file");

  const original = existing === null ? "" : existing.content;
  let text = original;
  for (const block of blocks) {
    const applied = applyBlock(text, block.id, block.lines);
    if ("conflict" in applied) return conflict(applied.conflict, original);
    text = applied.text;
  }

  if (existing === null) return { ...base, content: text, status: "create", existing: null, reason: null };
  return text === original
    ? { ...base, content: text, status: "unchanged", existing: original, reason: null }
    : { ...base, content: text, status: "update", existing: original, reason: null };
}

/** Plans an edit with a single managed block. */
export function planTextBlock(
  relPath: string,
  id: string,
  lines: readonly string[],
  readExisting: ReadExisting,
): Promise<PlannedFile> {
  return planTextBlocks(relPath, [{ id, lines }], readExisting);
}
