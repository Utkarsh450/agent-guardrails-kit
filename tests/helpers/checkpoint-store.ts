import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A real temporary project folder for tests that read and restore checkpoints. */
export async function tempProject(files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-checkpoint-")));
  for (const [rel, content] of Object.entries(files)) await put(root, rel, content);
  return root;
}

export async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split("/"));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

export interface SavedFile {
  path: string;
  existed: boolean;
  /** The saved content, when a copy was written. */
  content?: string;
  skipped?: string;
}

export const ID_A = "20261107T101000000Z-aaaa";
export const ID_B = "20261107T103000000Z-bbbb";

/** Lays out a checkpoint exactly as the guard does: manifest.json, files/<path>, and a line in index.log. */
export async function makeCheckpoint(root: string, id: string, files: SavedFile[], extra: { agent?: string; tool?: string } = {}): Promise<void> {
  const base = `.agent-guardrails/checkpoints/${id}`;
  const manifest = {
    version: 1,
    id,
    ts: `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}.${id.slice(15, 18)}Z`,
    agent: extra.agent ?? "claude",
    tool: extra.tool ?? "Write",
    files: files.map((file) => ({
      path: file.path,
      existed: file.existed,
      bytes: file.content === undefined ? 0 : Buffer.byteLength(file.content),
      ...(file.skipped ? { skipped: file.skipped } : {}),
    })),
  };
  for (const file of files) if (file.content !== undefined) await put(root, `${base}/files/${file.path}`, file.content);
  await put(root, `${base}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  const bytes = files.reduce((sum, file) => sum + (file.content === undefined ? 0 : Buffer.byteLength(file.content)), 0);
  const indexPath = path.join(root, ".agent-guardrails/checkpoints/index.log");
  const { appendFile } = await import("node:fs/promises");
  await appendFile(indexPath, `${JSON.stringify({ id, bytes })}\n`, "utf8").catch(async () => put(root, ".agent-guardrails/checkpoints/index.log", `${JSON.stringify({ id, bytes })}\n`));
}
