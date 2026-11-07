import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../shared/agents.ts";
import { memoryIo, type MemoryIo } from "../../../tests/helpers/memory-io.ts";
import { CHECKPOINT_LIMITS } from "../hooks/guard/guard.mjs";
import { buildSetupPlan } from "../setup/index.ts";
import { diagnose, type Check } from "./index.ts";

async function installed(settings: Record<string, unknown> = {}): Promise<MemoryIo> {
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

const MB = 1024 * 1024;
const check = async (settings: Record<string, unknown>, checkpoints?: { count: number; bytes: number } | null): Promise<Check | undefined> =>
  (await diagnose({ io: await installed(settings), hooksPathSet: true, nodeVersion: "v24.19.0", auditBytes: null, checkpoints })).checks.find((c) => c.id === "checkpoints");

describe("doctor and checkpoints", () => {
  it("is quiet when checkpoints are on and none exist", async () => {
    expect(await check({}, null)).toBeUndefined();
    expect(await check({})).toBeUndefined();
  });

  it("reports the count and size when there is room", async () => {
    const result = await check({}, { count: 12, bytes: 3 * MB });
    expect(result?.status).toBe("ok");
    expect(result?.detail).toBe("12 saved (limit 1000), 3.0 MB of 200 MB used");
  });

  it("warns when it is close to a limit", async () => {
    expect((await check({}, { count: 850, bytes: MB }))?.status).toBe("warn");
    const bytes = await check({}, { count: 5, bytes: 170 * MB });
    expect(bytes?.status).toBe("warn");
    expect(bytes?.detail).toMatch(/Close to the limit/);
  });

  it("warns that saving has stopped at a limit, and prints the cleanup step", async () => {
    for (const usage of [{ count: CHECKPOINT_LIMITS.maxCount, bytes: 0 }, { count: 1, bytes: CHECKPOINT_LIMITS.maxTotalBytes }]) {
      const result = await check({}, usage);
      expect(result?.status).toBe("warn");
      expect(result?.detail).toMatch(/no new copies are saved/);
      expect(result?.fix).toContain(".agent-guardrails/checkpoints");
    }
  });

  it("notes when checkpoints are switched off", async () => {
    const result = await check({ checkpoints: false }, null);
    expect(result?.status).toBe("info");
    expect(result?.detail).toMatch(/Checkpoints are off/);
  });
});
