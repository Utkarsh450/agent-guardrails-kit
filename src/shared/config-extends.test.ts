import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, GUARD_CONFIG_KEYS, parseConfig } from "./config.ts";

describe("the team preset settings", () => {
  it("are optional and unset by default", () => {
    expect(DEFAULT_CONFIG.extends).toBeUndefined();
    expect(DEFAULT_CONFIG.extendsHash).toBeUndefined();
    expect(parseConfig("{}").extends).toBeUndefined();
  });

  it("are read by the CLI only, not by the guard", () => {
    expect(GUARD_CONFIG_KEYS).not.toContain("extends");
    expect(GUARD_CONFIG_KEYS).not.toContain("extendsHash");
  });

  it("keep what was saved", () => {
    const config = parseConfig(JSON.stringify({ extends: "./team.json", extendsHash: "abc" }));
    expect(config).toMatchObject({ extends: "./team.json", extendsHash: "abc" });
  });

  it("must be text", () => {
    expect(() => parseConfig(JSON.stringify({ extends: 5 }))).toThrow(ConfigError);
  });
});
