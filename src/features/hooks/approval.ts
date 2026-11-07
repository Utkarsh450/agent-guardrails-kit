import { z } from "zod";
import { hashPlan } from "./guard/guard.mjs";

/**
 * The approval record the human creates with `agent-guardrails approve`.
 * The guard blocks file writes until a record exists whose hash matches the current plan file,
 * so editing the plan after approving it cancels the approval.
 */

export const STATE_DIR = ".agent-guardrails";
export const APPROVAL_FILE = `${STATE_DIR}/approval.json`;

const recordSchema = z.object({
  version: z.literal(1),
  plan: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  approvedAt: z.string(),
});

export type ApprovalRecord = z.infer<typeof recordSchema>;

export interface ApprovalState {
  approved: boolean;
  reason: string;
}

/** Same hash the guard computes (it is imported from the guard so the two cannot drift). */
export const planHash = hashPlan;

export function createApprovalRecord(planFile: string, planText: string, now: Date = new Date()): ApprovalRecord {
  return { version: 1, plan: planFile, sha256: planHash(planText), approvedAt: now.toISOString() };
}

export function serializeApproval(record: ApprovalRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function parseApprovalRecord(json: string): ApprovalRecord | null {
  try {
    const result = recordSchema.safeParse(JSON.parse(json));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** The same decision the guard makes, for `doctor` and `approve` to explain things to the human. */
export function verifyApproval(
  record: ApprovalRecord | null,
  planFile: string,
  planText: string | null,
): ApprovalState {
  if (record === null) return { approved: false, reason: "no approval on record" };
  if (record.plan !== planFile) {
    return { approved: false, reason: "approval record does not match the configured plan file" };
  }
  if (planText === null) return { approved: false, reason: `${planFile} does not exist` };
  if (planHash(planText) !== record.sha256) {
    return { approved: false, reason: `${planFile} changed after it was approved` };
  }
  return { approved: true, reason: "" };
}
