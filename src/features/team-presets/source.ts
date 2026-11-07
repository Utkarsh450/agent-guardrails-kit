import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeRelPath } from "../../shared/fs-plan.ts";
import { presetHash } from "./hash.ts";
import { PRESET_FILE, PRESET_MAX_BYTES, PresetError, parsePresetFile, type PresetFile } from "./schema.ts";
import { checkAllowCommands } from "./validate.ts";

export interface PresetSource {
  /** The form saved in the settings file: "./file.json" for a file, the package name for a package. */
  text: string;
  /** Where the preset file is, relative to the project folder. */
  rel: string;
  kind: "file" | "package";
}

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * Works out where a preset lives from what the person typed: a file inside the project, or the name of a package
 * that is already installed. URLs, git addresses and paths outside the project are refused. Reads nothing.
 */
export function parseSource(input: string): PresetSource {
  const typed = input.trim();
  if (typed === "") throw new PresetError("Say where the preset is: a file in the project (./team-preset.json) or the name of an installed package.");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(typed) || typed.startsWith("git@") || typed.startsWith("//")) {
    throw new PresetError(`"${typed}" looks like a URL or a git address. Presets are never fetched: use a file in the project, or a package that is already installed.`);
  }
  const looksLikeFile = typed.startsWith(".") || typed.endsWith(".json") || typed.includes("\\") || (typed.includes("/") && !typed.startsWith("@"));
  if (looksLikeFile) {
    let rel: string;
    try {
      rel = normalizeRelPath(typed);
    } catch {
      throw new PresetError(`"${typed}" is not a path inside the project (no absolute paths and no "..").`);
    }
    return { text: `./${rel}`, rel, kind: "file" };
  }
  if (PACKAGE_NAME.test(typed)) return { text: typed, rel: `node_modules/${typed}/${PRESET_FILE}`, kind: "package" };
  throw new PresetError(`"${typed}" is neither a file path nor a package name.`);
}

/**
 * Reads the preset file. The real location must be inside the project (a package linked by pnpm or a workspace is
 * fine; a link that leads outside is not), it must be a regular file, and it must be small.
 */
export async function readPresetText(root: string, source: PresetSource): Promise<string> {
  const abs = path.join(root, ...source.rel.split("/"));
  const rootReal = await realpath(root);
  let real: string;
  try {
    real = await realpath(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PresetError(
        source.kind === "package"
          ? `The package "${source.text}" is not installed here (there is no ${source.rel}). Install it yourself with your package manager, then try again.`
          : `${source.rel} does not exist.`,
      );
    }
    throw error;
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new PresetError(`${source.rel} leads outside the project folder, so it is not read.`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new PresetError(`${source.rel} is not a file.`);
  if (info.size > PRESET_MAX_BYTES) throw new PresetError(`${source.rel} is bigger than ${PRESET_MAX_BYTES / 1024} KB, which is far more than a preset needs.`);
  return readFile(real, "utf8");
}

export interface LoadedPreset {
  /** What to save as `extends`. */
  source: string;
  preset: PresetFile;
  hash: string;
}

/** Finds, reads and checks a preset. Throws PresetError, in plain words, for anything wrong with it. */
export async function loadPresetFromSource(root: string, input: string): Promise<LoadedPreset> {
  const source = parseSource(input);
  const text = await readPresetText(root, source);
  let preset: PresetFile;
  try {
    preset = parsePresetFile(text);
  } catch (error) {
    if (error instanceof PresetError) throw new PresetError(`${source.rel} ${error.message}`);
    throw error;
  }
  const problems = checkAllowCommands(preset.settings.allowCommands ?? []);
  if (problems.length > 0) {
    throw new PresetError(`${source.rel} asks for commands that cannot be allowed: ${problems.map((p) => `"${p.entry}" ${p.reason}`).join("; ")}.`);
  }
  return { source: source.text, preset, hash: presetHash(preset.settings) };
}
