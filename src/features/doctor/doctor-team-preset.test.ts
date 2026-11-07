import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../shared/agents.ts";
import { memoryIo, type MemoryIo } from "../../../tests/helpers/memory-io.ts";
import { buildSetupPlan } from "../setup/index.ts";
import { presetHash, type PresetSettings, type TeamPresetStatus } from "../team-presets/index.ts";
import { diagnose, type Check } from "./index.ts";

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

const check = async (settings: Record<string, unknown>, teamPreset?: TeamPresetStatus): Promise<Check | undefined> =>
  (await diagnose({ io: await installed(settings), hooksPathSet: true, nodeVersion: "v24.19.0", auditBytes: null, ...(teamPreset ? { teamPreset } : {}) })).checks.find((c) => c.id === "team-preset");

const ok = (settings: PresetSettings): TeamPresetStatus => ({ state: "ok", source: "./team.json", name: "acme", hash: presetHash(settings), settings });
const follows = (settings: PresetSettings, extra: Record<string, unknown> = {}) => ({ extends: "./team.json", extendsHash: presetHash(settings), ...extra });

describe("doctor and a team preset", () => {
  it("says nothing for a project that follows none", async () => {
    expect(await check({})).toBeUndefined();
  });

  it("notes that it was not checked when it could not be read here", async () => {
    const result = await check({ extends: "./team.json" });
    expect(result?.status).toBe("info");
  });

  it("fails when the source cannot be used, and says how to get out", async () => {
    const result = await check({ extends: "./team.json" }, { state: "error", source: "./team.json", error: "./team.json does not exist." });
    expect(result?.status).toBe("fail");
    expect(result?.detail).toMatch(/does not exist/);
    expect(result?.fix).toMatch(/remove "extends"/);
  });

  it("is happy when the project matches the preset", async () => {
    const settings = { allowCommands: ["pnpm test"] };
    const result = await check({ ...follows(settings), allowCommands: ["pnpm test"] }, ok(settings));
    expect(result?.status).toBe("ok");
    expect(result?.detail).toMatch(/up to date/);
  });

  it("warns when the preset would add something the project lacks", async () => {
    const settings = { allowCommands: ["pnpm test", "pnpm lint"] };
    const result = await check({ ...follows(settings), allowCommands: ["pnpm test"] }, ok(settings));
    expect(result?.status).toBe("warn");
    expect(result?.detail).toMatch(/behind the team preset "acme"/);
    expect(result?.fix).toBe("agent-guardrails update");
  });

  it("warns when the preset changed, even if there is nothing to add", async () => {
    const result = await check({ extends: "./team.json", extendsHash: "old", allowCommands: ["pnpm test"] }, ok({ allowCommands: ["pnpm test"] }));
    expect(result?.status).toBe("warn");
    expect(result?.detail).toMatch(/changed since it was applied/);
  });
});
