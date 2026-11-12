import { describe, expect, it } from "vitest";
import { configSchema, PRESETS, STACKS } from "../../shared/config.ts";
import { memoryIo } from "../../../tests/helpers/memory-io.ts";
import { makeContext } from "../hooks/sandbox.ts";
import { validateConfig } from "../hooks/guard/guard.mjs";
import { shell } from "../../../tests/helpers/guard-ctx.ts";
import { PACKAGE_MANAGERS } from "../package-manager/index.ts";
import { PRESET_SUMMARY, STACK_SUMMARY, TEAM_GIT_ALLOW, detectStack, presetSettings, stackAllowCommands } from "./index.ts";

describe("presets never weaken the protection", () => {
  for (const preset of PRESETS) {
    for (const stack of STACKS) {
      for (const manager of [...PACKAGE_MANAGERS, null]) {
        const label = `${preset} / ${stack} / ${manager ?? "no manager"}`;

        it(`${label}: keeps the gate on (except light), asks about unknown commands, and stays valid`, () => {
          const settings = presetSettings(preset, stack, manager);
          expect(settings.approvalGate).toBe(preset !== "light");
          expect(settings.policy).toBe("ask");
          expect(settings.gitAllow).toEqual(expect.arrayContaining(["status", "diff", "log", "show"]));
          expect(validateConfig(settings).error).toBeUndefined();
          expect(configSchema.safeParse(settings).success).toBe(true);
        });

        it(`${label}: hard blocks still apply, and its own commands really are allowed`, () => {
          const settings = presetSettings(preset, stack, manager);
          const ctx = makeContext({ config: settings });
          for (const hard of ["rm -rf x", "git push", "git commit -m x", "gh pr list", "sudo ls", "git reset --hard", "npm publish"]) {
            expect(shell(hard, ctx).decision, `${label}: ${hard}`).toBe("deny");
          }
          expect(shell("python -c 'print(1)'", ctx).decision).toBe("ask");
          for (const pattern of settings.allowCommands) {
            const result = shell(pattern, ctx);
            expect(result, `${label}: ${pattern}`).toMatchObject({ decision: "allow", rule: "user-allowed" });
          }
        });
      }
    }
  }

  it("learner logs everything and repeats rules per agent; balanced does neither; team allows more read-only git", () => {
    expect(presetSettings("learner", "generic", null)).toMatchObject({ auditAllowed: true, alwaysRuleFiles: true, allowCommands: [] });
    expect(presetSettings("balanced", "generic", null)).toMatchObject({ auditAllowed: false, alwaysRuleFiles: false, allowCommands: [] });
    const balanced = presetSettings("balanced", "node-ts", "pnpm");
    expect(balanced).toMatchObject({ auditAllowed: false, alwaysRuleFiles: false, gitAllow: ["status", "diff", "log", "show"] });
    expect(balanced.allowCommands).toEqual(expect.arrayContaining(["pnpm test", "pnpm build", "tsc --noEmit"]));
    expect(presetSettings("learner", "node-ts", "pnpm").allowCommands).toEqual([]);
    const team = presetSettings("team", "node-ts", "pnpm");
    expect(team.gitAllow).toEqual(expect.arrayContaining([...TEAM_GIT_ALLOW]));
    expect(team.allowCommands).toEqual(expect.arrayContaining(["pnpm test", "pnpm build", "tsc --noEmit"]));
  });

  it("light is the only preset without the plan gate, and keeps checkpoints and the question for unknown commands", () => {
    const light = presetSettings("light", "node-ts", "pnpm");
    expect(light).toMatchObject({ approvalGate: false, policy: "ask" });
    expect(light.gitAllow).toEqual(expect.arrayContaining([...TEAM_GIT_ALLOW]));
    expect(light.allowCommands).toContain("pnpm test");
    for (const preset of ["learner", "balanced", "team"] as const) expect(presetSettings(preset, "generic", null).approvalGate).toBe(true);
    expect(configSchema.parse({}).checkpoints).toBe(true);
    const ctx = makeContext({ config: light });
    expect(shell("rm -rf x", ctx).decision).toBe("deny");
    expect(shell("python -c 'print(1)'", ctx).decision).toBe("ask");
  });

  it("db-heavy logs everything for any preset", () => {
    expect(presetSettings("balanced", "db-heavy", null).auditAllowed).toBe(true);
  });

  it("team's extra git commands are all read-only and none is on the never-allowed list", () => {
    const ctx = makeContext({ config: presetSettings("team", "generic", null) });
    for (const sub of TEAM_GIT_ALLOW) expect(shell(`git ${sub}`, ctx).decision, sub).toBe("allow");
  });

  it("describes every preset and stack", () => {
    for (const preset of PRESETS) expect(PRESET_SUMMARY[preset].length).toBeGreaterThan(20);
    for (const stack of STACKS) expect(STACK_SUMMARY[stack].length).toBeGreaterThan(5);
  });
});

describe("stackAllowCommands", () => {
  it("uses the project's package manager for Node", () => {
    expect(stackAllowCommands("node-ts", "bun")).toEqual(expect.arrayContaining(["bun test", "bun run build"]));
    expect(stackAllowCommands("node-ts", null)).toContain("npm test");
  });
  it("covers Python and Go and leaves others empty", () => {
    expect(stackAllowCommands("python", null)).toContain("pytest");
    expect(stackAllowCommands("go", null)).toContain("go test");
    expect(stackAllowCommands("generic", "npm")).toEqual([]);
    expect(stackAllowCommands("db-heavy", "npm")).toEqual([]);
  });
});

describe("detectStack", () => {
  const detect = (files: Record<string, string>) => detectStack(memoryIo(files).readExisting);

  it("recognises each language", async () => {
    expect(await detect({ "tsconfig.json": "{}" })).toEqual({ stack: "node-ts", evidence: "tsconfig.json" });
    expect(await detect({ "package.json": "{}" })).toEqual({ stack: "node-ts", evidence: "package.json" });
    expect(await detect({ "pyproject.toml": "" })).toEqual({ stack: "python", evidence: "pyproject.toml" });
    expect(await detect({ "go.mod": "" })).toEqual({ stack: "go", evidence: "go.mod" });
  });

  it("suggests db-heavy only when no language is found, and generic when nothing is", async () => {
    expect((await detect({ "prisma/schema.prisma": "x" })).stack).toBe("db-heavy");
    expect((await detect({ "prisma/schema.prisma": "x", "package.json": "{}" })).stack).toBe("node-ts");
    expect(await detect({})).toEqual({ stack: "generic", evidence: null });
  });
});
