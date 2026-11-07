import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_IDS, isAgentId, type AgentId } from "../../shared/agents.ts";
import { CONFIG_FILE, PRESETS, STACKS, type Preset, type Stack } from "../../shared/config.ts";
import { CliError } from "./errors.ts";
import type { Ui } from "./ui.ts";

export interface CommandContext {
  /** The project folder the command works on. */
  cwd: string;
  ui: Ui;
}

/** Resolves the project folder and refuses places where setting up guardrails makes no sense. */
export function resolveRoot(cwd: string): string {
  const root = path.resolve(cwd);
  let info;
  try {
    info = statSync(root);
  } catch {
    throw new CliError(`The folder ${root} does not exist.`);
  }
  if (!info.isDirectory()) throw new CliError(`${root} is not a folder.`);
  const real = realpathSync(root);
  if (real === path.parse(real).root) throw new CliError("Refusing to set up guardrails in the root of the file system. Go into a project folder first.");
  if (real === realpathSync(os.homedir())) {
    throw new CliError("Refusing to set up guardrails directly in your home folder. Go into a project folder first, or pass --cwd <folder>.");
  }
  return real;
}

/**
 * Finds the project a command should work on: the nearest folder at or above `cwd` that holds the guardrail
 * settings. Falls back to `cwd` itself, so running from a subfolder works and a project that has not been set
 * up yet is reported as such. Never climbs past the home folder.
 */
export function findProjectRoot(cwd: string): string {
  const start = resolveRoot(cwd);
  const home = realpathSync(os.homedir());
  let dir = start;
  for (let step = 0; step < 15; step += 1) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || parent === home || dir === home) break;
    dir = parent;
  }
  return start;
}

/** Turns "claude,cursor" (or "all") into agent ids. */
export function parseAgentList(text: string): AgentId[] {
  if (text.trim().toLowerCase() === "all") return [...AGENT_IDS];
  const wanted = text.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) throw new CliError(`No agents given. Use ${AGENT_IDS.join(", ")} (comma separated) or "all".`);
  const unknown = wanted.filter((name) => !isAgentId(name));
  if (unknown.length > 0) throw new CliError(`Unknown agent: ${unknown.join(", ")}. Choose from ${AGENT_IDS.join(", ")} or "all".`);
  return [...new Set(wanted as AgentId[])];
}

export function parsePreset(text: string): Preset {
  if ((PRESETS as readonly string[]).includes(text)) return text as Preset;
  throw new CliError(`Unknown preset "${text}". Choose from ${PRESETS.join(", ")}.`);
}

export function parseStack(text: string): Stack {
  if ((STACKS as readonly string[]).includes(text)) return text as Stack;
  throw new CliError(`Unknown stack "${text}". Choose from ${STACKS.join(", ")}.`);
}
