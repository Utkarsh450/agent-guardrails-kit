import { describe, expect, it } from "vitest";
import { ROOT, writeFile } from "../../../tests/helpers/guard-ctx.ts";
import {
  createApprovalRecord,
  parseApprovalRecord,
  planHash,
  serializeApproval,
  verifyApproval,
} from "./approval.ts";
import { fakeFs, makeContext } from "./sandbox.ts";

const PLAN = "# Plan\n- one\n- two\n";

describe("approval records", () => {
  it("round-trips through JSON", () => {
    const record = createApprovalRecord("PLAN.md", PLAN, new Date("2026-11-05T10:00:00Z"));
    expect(record).toMatchObject({ version: 1, plan: "PLAN.md", approvedAt: "2026-11-05T10:00:00.000Z" });
    expect(parseApprovalRecord(serializeApproval(record))).toEqual(record);
  });

  it("rejects malformed records", () => {
    expect(parseApprovalRecord("not json")).toBeNull();
    expect(parseApprovalRecord("{}")).toBeNull();
    expect(parseApprovalRecord(JSON.stringify({ version: 1, plan: "P", sha256: "short", approvedAt: "x" }))).toBeNull();
    expect(parseApprovalRecord(JSON.stringify({ version: 2, plan: "P", sha256: "a".repeat(64), approvedAt: "x" }))).toBeNull();
  });

  it("verifies against the plan on disk", () => {
    const record = createApprovalRecord("PLAN.md", PLAN);
    expect(verifyApproval(record, "PLAN.md", PLAN)).toEqual({ approved: true, reason: "" });
    expect(verifyApproval(null, "PLAN.md", PLAN).approved).toBe(false);
    expect(verifyApproval(record, "PLAN.md", `${PLAN}more`).reason).toMatch(/changed/);
    expect(verifyApproval(record, "PLAN.md", null).reason).toMatch(/does not exist/);
    expect(verifyApproval(record, "OTHER.md", PLAN).reason).toMatch(/does not match/);
  });

  it("uses the same hash as the guard, including Windows line endings", () => {
    expect(planHash("a\r\nb")).toBe(planHash("a\nb"));
  });

  it("produces records the guard accepts, and the guard rejects once the plan changes", () => {
    const record = createApprovalRecord("PLAN.md", PLAN);
    const files = {
      [`${ROOT}/PLAN.md`]: PLAN,
      [`${ROOT}/.agent-guardrails/approval.json`]: serializeApproval(record),
    };
    const ctx = makeContext();
    ctx.fs = fakeFs(files);
    expect(writeFile(`${ROOT}/src/a.ts`, "x", ctx).decision).toBe("allow");

    const edited = makeContext();
    edited.fs = fakeFs({ ...files, [`${ROOT}/PLAN.md`]: `${PLAN}- sneaky extra step\n` });
    expect(writeFile(`${ROOT}/src/a.ts`, "x", edited)).toMatchObject({ decision: "deny", rule: "no-approved-plan" });
  });

  it("agrees with the guard on every state", () => {
    const record = createApprovalRecord("PLAN.md", PLAN);
    const cases: Array<{ name: string; files: Record<string, string>; ts: boolean }> = [
      { name: "no record", files: { [`${ROOT}/PLAN.md`]: PLAN }, ts: verifyApproval(null, "PLAN.md", PLAN).approved },
      {
        name: "valid",
        files: { [`${ROOT}/PLAN.md`]: PLAN, [`${ROOT}/.agent-guardrails/approval.json`]: serializeApproval(record) },
        ts: verifyApproval(record, "PLAN.md", PLAN).approved,
      },
      {
        name: "plan missing",
        files: { [`${ROOT}/.agent-guardrails/approval.json`]: serializeApproval(record) },
        ts: verifyApproval(record, "PLAN.md", null).approved,
      },
      {
        name: "plan edited",
        files: { [`${ROOT}/PLAN.md`]: "other", [`${ROOT}/.agent-guardrails/approval.json`]: serializeApproval(record) },
        ts: verifyApproval(record, "PLAN.md", "other").approved,
      },
    ];
    for (const c of cases) {
      const ctx = makeContext();
      ctx.fs = fakeFs(c.files);
      const guardAllows = writeFile(`${ROOT}/src/a.ts`, "x", ctx).decision === "allow";
      expect(guardAllows, c.name).toBe(c.ts);
    }
  });
});
