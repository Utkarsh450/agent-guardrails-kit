export { buildPresetFromConfig, serializePreset } from "./export.ts";
export { presetHash } from "./hash.ts";
export { isBehind, mergeSettings, type MergedSettings } from "./merge.ts";
export { PRESET_FILE, PRESET_KIND, PRESET_MAX_BYTES, PresetError, parsePresetFile, presetFileSchema, type PresetFile, type PresetSettings } from "./schema.ts";
export { loadPresetFromSource, parseSource, readPresetText, type LoadedPreset, type PresetSource } from "./source.ts";
export { checkAllowCommands, type AllowProblem } from "./validate.ts";

import type { PresetSettings } from "./schema.ts";

/** A preset as `update` applies it. */
export interface AppliedPreset {
  settings: PresetSettings;
  source: string;
  hash: string;
}

/** What `doctor` knows about the team preset a project follows. */
export type TeamPresetStatus =
  | { state: "ok"; source: string; name: string; hash: string; settings: PresetSettings }
  | { state: "error"; source: string; error: string };
