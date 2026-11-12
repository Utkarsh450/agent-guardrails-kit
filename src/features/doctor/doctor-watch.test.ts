import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../shared/agents.ts";
import { memoryIo, type MemoryIo } from "../../../tests/helpers/memory-io.ts";
import { buildSetupPlan } from "../setup/index.ts";
import { diagnose, type Check } from "./index.ts";

const NOW = new Date("2026-11-07T09:00:00.000Z");

async function installed(settings: Record<string, unknown>): Promise<MemoryIo> {
  const io = memoryIo({ ".git/HEAD": "ref: refs/heads/main" });
  const plan = await buildSetupPlan({
    options: { agents: [...AGENT_IDS], preset: "balanced", stack: "node-ts", packageManager: "pnpm", github: true },
    io,
    hooksPathSet: true,
  });
  for (const { file } of plan.entries) if (file.status === "create" || file.status === "update") io.files.set(file.path, file.content);
  const config = JSON.parse(io.files.get("agent-guardrails.config.json") ?? "{}") as Record<string, unknown>;
  io.files.set("agent-guardrails.config.json", `${JSON.stringify({ ...config, ...settings }, null, 2)}\n`);
  return io;
}

const watchCheck = async (settings: Record<string, unknown>): Promise<Check | undefined> =>
  (await diagnose({ io: await installed(settings), hooksPathSet: true, nodeVersion: "v24.19.0", auditBytes: null, now: NOW })).checks.find((c) => c.id === "watch");

describe("doctor and watch mode", () => {
  it("says nothing when the guard is enforcing", async () => {
    expect(await watchCheck({})).toBeUndefined();
    expect(await watchCheck({ mode: "enforce", watchUntil: null })).toBeUndefined();
  });

  it("warns while watch mode is on, with the end date and the way back", async () => {
    const check = await watchCheck({ mode: "watch", watchUntil: "2026-11-14T09:00:00.000Z" });
    expect(check?.status).toBe("warn");
    expect(check?.detail).toMatch(/until 2026-11-14T09:00:00.000Z/);
    expect(check?.fix).toBe("agent-guardrails-kit mode enforce");
  });

  it("explains that an expired or open-ended watch mode is not active", async () => {
    for (const settings of [{ mode: "watch", watchUntil: "2026-11-01T09:00:00.000Z" }, { mode: "watch" }]) {
      const check = await watchCheck(settings);
      expect(check?.status, JSON.stringify(settings)).toBe("info");
      expect(check?.detail).toMatch(/enforcing/);
    }
  });
});
