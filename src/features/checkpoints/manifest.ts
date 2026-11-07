import { z } from "zod";

/** A checkpoint id: the time to the millisecond, then four random hex characters. Checked before an id is used as a folder name. */
export const CHECKPOINT_ID = /^\d{8}T\d{9}Z-[0-9a-f]{4}$/;

export const SKIP_REASONS = {
  "ignored-folder": "it is in a folder that is never copied (node_modules, .git, dist, build) or is a secret file",
  "not-a-file": "it is a folder, not a file",
  "too-big": "it is bigger than the 1 MB limit",
  unreadable: "it could not be read",
  "not-text": "it is not plain text that copies back byte for byte",
} as const;

const fileSchema = z.object({
  path: z.string().min(1),
  /** Whether the file was there before the change. False means the agent created it. */
  existed: z.boolean(),
  bytes: z.number().int().nonnegative(),
  /** Why the content was not saved (the file is listed anyway). */
  skipped: z.enum(["ignored-folder", "not-a-file", "too-big", "unreadable", "not-text"]).optional(),
});

export const manifestSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(CHECKPOINT_ID),
  ts: z.string(),
  agent: z.string(),
  tool: z.string(),
  files: z.array(fileSchema),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestFile = Manifest["files"][number];

/** Reads a manifest file, or returns null when it is not a valid one (a half-written or edited file). */
export function parseManifest(text: string): Manifest | null {
  try {
    const result = manifestSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
