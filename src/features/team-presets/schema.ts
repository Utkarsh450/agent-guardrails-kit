import { z } from "zod";
import { SAFE_GIT_ALLOW } from "../presets/index.ts";

/** The `kind` every preset file carries, so a random JSON file is not mistaken for one. */
export const PRESET_KIND = "agent-guardrails-preset";
/** The file name inside an npm package, and the default name `preset export` writes. */
export const PRESET_FILE = "guardrails-preset.json";
/** A preset is a few lines of settings; anything bigger is not one. */
export const PRESET_MAX_BYTES = 64 * 1024;

/** Anything wrong with a preset: its source, its content or what it asks for. The message is plain words for the person. */
export class PresetError extends Error {
  override name = "PresetError";
}

/**
 * The only settings a preset may carry. Every one can only keep or raise protection (see merge.ts), and any other
 * key (`mode`, `watchUntil`, `agents`, `stack`, `extends`, ...) makes the file invalid.
 */
const settingsSchema = z.strictObject({
  /** "blocklist" lets unknown commands run without asking, so a preset cannot ask for it. */
  policy: z.enum(["ask", "allowlist"]).optional(),
  allowCommands: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  gitAllow: z
    .array(z.string().refine((value) => SAFE_GIT_ALLOW.includes(value), { message: `must be a read-only git command: ${SAFE_GIT_ALLOW.join(", ")}` }))
    .max(30)
    .optional(),
  /** A preset cannot switch the plan gate off. */
  approvalGate: z.literal(true).optional(),
  auditAllowed: z.boolean().optional(),
  alwaysRuleFiles: z.boolean().optional(),
  checkpoints: z.boolean().optional(),
});

export const presetFileSchema = z.strictObject({
  kind: z.literal(PRESET_KIND),
  version: z.literal(1),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300).optional(),
  settings: settingsSchema,
});

export type PresetFile = z.infer<typeof presetFileSchema>;
export type PresetSettings = z.infer<typeof settingsSchema>;

/** Reads the text of a preset file. Throws PresetError with every problem found. */
export function parsePresetFile(text: string): PresetFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new PresetError(`is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const result = presetFileSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
    throw new PresetError(`is not a valid preset (${issues.join("; ")})`);
  }
  return result.data;
}
