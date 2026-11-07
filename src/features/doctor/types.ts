export type Status = "ok" | "warn" | "fail" | "info";

export interface Check {
  /** Stable id, for scripts and tests. */
  id: string;
  /** Group heading: Settings, Guard, Agents, Rules, Git, GitHub, Approval. */
  area: string;
  title: string;
  status: Status;
  /** What was found, in plain words. */
  detail?: string;
  /** The command or step that fixes it. */
  fix?: string;
}

export interface DoctorResult {
  checks: Check[];
  counts: Record<Status, number>;
}

export function summarizeChecks(checks: readonly Check[]): DoctorResult {
  const counts: Record<Status, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const check of checks) counts[check.status] += 1;
  return { checks: [...checks], counts };
}
