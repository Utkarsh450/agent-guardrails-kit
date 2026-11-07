import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, GUARD_CONFIG_KEYS, parseConfig } from "./config.ts";

describe("checkpoints setting", () => {
  it("is on by default and read by the guard", () => {
    expect(DEFAULT_CONFIG.checkpoints).toBe(true);
    expect(parseConfig("{}").checkpoints).toBe(true);
    expect(GUARD_CONFIG_KEYS).toContain("checkpoints");
  });

  it("can be switched off, and only with a true or false", () => {
    expect(parseConfig(JSON.stringify({ checkpoints: false })).checkpoints).toBe(false);
    expect(() => parseConfig(JSON.stringify({ checkpoints: "no" }))).toThrow(ConfigError);
  });
});
