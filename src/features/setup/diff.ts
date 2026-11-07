import { createTwoFilesPatch } from "diff";
import type { PlanEntry } from "./types.ts";

const MAX_LINES = 60;

/** A unified diff of what would change in one file, trimmed so a long file does not flood the screen. */
export function renderDiff(entry: PlanEntry): string {
  const { file } = entry;
  const before = file.existing ?? "";
  const patch = createTwoFilesPatch(`a/${file.path}`, `b/${file.path}`, before, file.content, "", "", { context: 2 });
  const lines = patch.split("\n").slice(2); // drop the "Index:" and "====" header lines
  if (lines.length <= MAX_LINES) return lines.join("\n").trimEnd();
  return `${lines.slice(0, MAX_LINES).join("\n")}\n... ${lines.length - MAX_LINES} more lines`;
}

/** The first lines of a file that will be created. */
export function renderPreview(entry: PlanEntry, maxLines = 12): string {
  const lines = entry.file.content.split("\n");
  const shown = lines.slice(0, maxLines).join("\n");
  return lines.length > maxLines ? `${shown}\n... ${lines.length - maxLines} more lines` : shown.trimEnd();
}
