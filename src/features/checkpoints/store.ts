import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeRelPath } from "../../shared/fs-plan.ts";
import { CHECKPOINT_DIR } from "../hooks/guard/guard.mjs";
import { CHECKPOINT_ID, parseManifest, type Manifest } from "./manifest.ts";

export interface CheckpointUsage {
  count: number;
  bytes: number;
}

const storeDir = (root: string) => path.join(root, ...CHECKPOINT_DIR.split("/"));

const isMissing = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";

/** How many checkpoints the guard has saved and how many bytes of file content they hold, from its own index. Null when there are none. */
export async function checkpointUsage(root: string): Promise<CheckpointUsage | null> {
  let text: string;
  try {
    text = await readFile(path.join(storeDir(root), "index.log"), "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let count = 0;
  let bytes = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    count += 1;
    try {
      bytes += Number((JSON.parse(line) as { bytes?: unknown }).bytes) || 0;
    } catch {
      // a torn line still counts as one checkpoint
    }
  }
  return count === 0 ? null : { count, bytes };
}

/** One checkpoint's manifest, or null when there is no such checkpoint (or its manifest is not valid). */
export async function readCheckpoint(root: string, id: string): Promise<Manifest | null> {
  if (!CHECKPOINT_ID.test(id)) return null;
  try {
    const manifest = parseManifest(await readFile(path.join(storeDir(root), id, "manifest.json"), "utf8"));
    return manifest !== null && manifest.id === id ? manifest : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** The newest checkpoints first. Folders without a valid manifest (half written) are left out. */
export async function listCheckpoints(root: string, limit = 20): Promise<Manifest[]> {
  let names: string[];
  try {
    names = await readdir(storeDir(root));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const ids = names.filter((name) => CHECKPOINT_ID.test(name)).sort().reverse();
  const found: Manifest[] = [];
  for (const id of ids) {
    if (found.length >= limit) break;
    const manifest = await readCheckpoint(root, id);
    if (manifest !== null) found.push(manifest);
  }
  return found;
}

/** The content saved for one file of a checkpoint, or null when the copy is missing. `rel` must already be a safe relative path. */
export async function readSavedFile(root: string, id: string, rel: string): Promise<string | null> {
  if (!CHECKPOINT_ID.test(id)) return null;
  const safe = normalizeRelPath(rel);
  try {
    return await readFile(path.join(storeDir(root), id, "files", ...safe.split("/")), "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
