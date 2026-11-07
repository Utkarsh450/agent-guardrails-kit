import { diskReadExisting, normalizeRelPath, type PlannedFile } from "../../shared/fs-plan.ts";
import { SKIP_REASONS, type Manifest } from "./manifest.ts";
import { readSavedFile } from "./store.ts";

export interface RestorePlan {
  /** Files that will be written back (create or update). */
  files: PlannedFile[];
  /** Files already identical to the saved copy. */
  unchanged: string[];
  /** Files the agent created. Restore never deletes, so these are only reported. */
  createdByAgent: string[];
  /** Files that cannot be restored, with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

/** Folders restore never writes into, whatever a manifest says. */
const NEVER = /^(\.git|\.agent-guardrails)(\/|$)/;

/**
 * Works out what restoring a checkpoint would do. Reads only. Every path in the manifest is checked again here,
 * because a manifest is just a file on disk: it must be relative, stay inside the project and avoid the kit's own folders.
 */
export async function planRestore(root: string, manifest: Manifest, only?: string): Promise<RestorePlan> {
  const plan: RestorePlan = { files: [], unchanged: [], createdByAgent: [], skipped: [] };
  const read = diskReadExisting(root);

  for (const entry of manifest.files) {
    let rel: string;
    try {
      rel = normalizeRelPath(entry.path);
    } catch {
      plan.skipped.push({ path: entry.path, reason: "the path is not inside the project" });
      continue;
    }
    if (only !== undefined && rel !== only) continue;
    if (NEVER.test(rel)) {
      plan.skipped.push({ path: rel, reason: "the kit never restores into that folder" });
      continue;
    }

    const current = await read(rel);
    if (current !== null && current.kind !== "file") {
      plan.skipped.push({ path: rel, reason: "it is not a regular file now" });
      continue;
    }

    if (!entry.existed) {
      if (current !== null) plan.createdByAgent.push(rel);
      continue;
    }
    if (entry.skipped !== undefined) {
      plan.skipped.push({ path: rel, reason: `no copy was saved: ${SKIP_REASONS[entry.skipped]}` });
      continue;
    }
    const saved = await readSavedFile(root, manifest.id, rel);
    if (saved === null) {
      plan.skipped.push({ path: rel, reason: "the saved copy is missing" });
      continue;
    }
    if (current !== null && current.content === saved) {
      plan.unchanged.push(rel);
      continue;
    }
    plan.files.push({
      path: rel,
      content: saved,
      generated: false,
      status: current === null ? "create" : "update",
      existing: current?.content ?? null,
      reason: null,
    });
  }
  return plan;
}
