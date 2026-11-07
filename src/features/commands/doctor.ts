import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUDIT_FILE } from "../hooks/index.ts";
import { diagnose, type Check, type DoctorResult, type Status } from "../doctor/index.ts";
import { ANTIGRAVITY_USER_SETTINGS } from "../agents/index.ts";
import { diskSyncIo } from "../rules/index.ts";
import { readHooksPath } from "../setup/index.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";

export interface DoctorOptions {
  /** Plain output for CI. The exit code already reflects failures. */
  ci?: boolean;
  json?: boolean;
  /** Also fail on warnings. */
  strict?: boolean;
  /** Read ~/.gemini/antigravity-cli/settings.json to check Antigravity's permission rules. */
  checkUserSettings?: boolean;
}

const LABEL: Record<Status, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", info: "info" };

/** Plain-text report, grouped by area. Also used to give the gap-review prompt something to read. */
export function formatDoctor(result: DoctorResult): string {
  const lines: string[] = [];
  const areas = [...new Set(result.checks.map((c) => c.area))];
  for (const area of areas) {
    lines.push(area);
    for (const check of result.checks.filter((c) => c.area === area)) {
      lines.push(`  [${LABEL[check.status]}] ${check.title}${check.detail ? `: ${check.detail}` : ""}`);
      if (check.fix && check.status !== "ok") lines.push(`         fix: ${check.fix}`);
    }
    lines.push("");
  }
  const { ok, warn, fail, info } = result.counts;
  lines.push(`${ok} ok, ${warn} warning(s), ${fail} problem(s), ${info} note(s)`);
  return lines.join("\n");
}

/** Gathers what the diagnosis needs from the real project and machine. */
export async function gatherDoctor(root: string, options: DoctorOptions = {}): Promise<DoctorResult> {
  const io = diskSyncIo(root);
  let auditBytes: number | null = null;
  try {
    auditBytes = statSync(path.join(root, AUDIT_FILE)).size;
  } catch {
    // no audit log yet
  }
  let antigravityUserSettings: string | null | undefined;
  if (options.checkUserSettings) {
    const file = path.join(os.homedir(), ANTIGRAVITY_USER_SETTINGS.replace(/^~\//, ""));
    antigravityUserSettings = await readFile(file, "utf8").catch(() => "");
    if (antigravityUserSettings === "") antigravityUserSettings = "{}";
  }
  const isRepo = (await io.readExisting(".git")) !== null;
  return diagnose({
    io,
    hooksPathSet: isRepo ? readHooksPath(root) : null,
    nodeVersion: process.version,
    auditBytes,
    ...(antigravityUserSettings !== undefined ? { antigravityUserSettings } : {}),
  });
}

/** `agent-guardrails doctor`: reports what works, what is out of date and what is missing. */
export async function runDoctor(ctx: CommandContext, options: DoctorOptions = {}): Promise<number> {
  const { ui } = ctx;
  const root = findProjectRoot(ctx.cwd);
  const result = await gatherDoctor(root, options);

  if (options.json) {
    ui.print(JSON.stringify(result, null, 2));
  } else {
    if (!options.ci) ui.intro("agent-guardrails doctor");
    ui.print(formatDoctor(result));
    if (!options.ci) {
      const fixes = [...new Set(result.checks.filter((c: Check) => c.status === "fail" && c.fix).map((c) => c.fix as string))];
      if (fixes.length > 0) ui.outro(`Start with: ${fixes[0]}`);
      else ui.outro(result.counts.warn > 0 ? "No problems, but see the warnings above." : "Everything checks out.");
    }
  }
  return result.counts.fail > 0 || (options.strict === true && result.counts.warn > 0) ? 1 : 0;
}
