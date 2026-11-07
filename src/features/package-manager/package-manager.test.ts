import { describe, expect, it } from "vitest";
import { memoryIo } from "../../../tests/helpers/memory-io.ts";
import { PACKAGE_MANAGERS, detectPackageManager, runnerCommand, scriptCommands } from "./index.ts";

const detect = (files: Record<string, string>) => detectPackageManager(memoryIo(files).readExisting);

describe("detectPackageManager", () => {
  it.each([
    [{ "pnpm-lock.yaml": "x" }, "pnpm"],
    [{ "package-lock.json": "{}" }, "npm"],
    [{ "npm-shrinkwrap.json": "{}" }, "npm"],
    [{ "yarn.lock": "x" }, "yarn"],
    [{ "bun.lock": "x" }, "bun"],
    [{ "bun.lockb": "x" }, "bun"],
  ] as const)("reads the lockfile: %j -> %s", async (files, manager) => {
    const found = await detect(files);
    expect(found.manager).toBe(manager);
    expect(found.evidence).toBe(Object.keys(files)[0]);
    expect(found.ambiguous).toEqual([]);
  });

  it("prefers the packageManager field over lockfiles", async () => {
    const found = await detect({ "package.json": JSON.stringify({ packageManager: "pnpm@11.24.0" }), "package-lock.json": "{}" });
    expect(found).toEqual({ manager: "pnpm", evidence: 'package.json packageManager "pnpm@11.24.0"', ambiguous: [] });
  });

  it("ignores an unknown or broken packageManager field and falls back to lockfiles", async () => {
    expect((await detect({ "package.json": JSON.stringify({ packageManager: "deno@1" }), "yarn.lock": "x" })).manager).toBe("yarn");
    expect((await detect({ "package.json": "{ nope", "bun.lock": "x" })).manager).toBe("bun");
    expect((await detect({ "package.json": JSON.stringify({ packageManager: 5 }) })).manager).toBeNull();
  });

  it("reports when more than one manager's lockfile is present", async () => {
    const found = await detect({ "pnpm-lock.yaml": "x", "package-lock.json": "{}" });
    expect(found.manager).toBe("pnpm");
    expect(found.ambiguous.sort()).toEqual(["npm", "pnpm"]);
  });

  it("returns nothing for a project without a clue", async () => {
    expect(await detect({})).toEqual({ manager: null, evidence: null, ambiguous: [] });
    expect(await detect({ "package.json": "{}" })).toEqual({ manager: null, evidence: null, ambiguous: [] });
  });
});

describe("command helpers", () => {
  it("map scripts to each manager's syntax", () => {
    expect(scriptCommands("npm")).toEqual({ test: "npm test", build: "npm run build", lint: "npm run lint", typecheck: "npm run typecheck" });
    expect(scriptCommands("pnpm").build).toBe("pnpm build");
    expect(scriptCommands("yarn").typecheck).toBe("yarn typecheck");
    expect(scriptCommands("bun").test).toBe("bun test");
    expect(scriptCommands("bun").build).toBe("bun run build");
  });

  it("name the way to run a package without installing it", () => {
    expect(PACKAGE_MANAGERS.map(runnerCommand)).toEqual(["npx", "pnpm dlx", "yarn dlx", "bunx"]);
  });
});
