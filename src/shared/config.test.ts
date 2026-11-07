import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, GUARD_CONFIG_KEYS, MODES, WATCH_DEFAULT_DAYS, WATCH_MAX_DAYS, parseConfig } from "./config.ts";

describe("watch mode settings", () => {
  it("defaults to enforce with no end date", () => {
    expect(DEFAULT_CONFIG).toMatchObject({ mode: "enforce", watchUntil: null });
    expect(parseConfig("{}")).toMatchObject({ mode: "enforce", watchUntil: null });
  });

  it("is read by the guard", () => {
    expect(GUARD_CONFIG_KEYS).toContain("mode");
    expect(GUARD_CONFIG_KEYS).toContain("watchUntil");
    expect(MODES).toEqual(["enforce", "watch"]);
  });

  it("keeps the default length inside the limit", () => {
    expect(WATCH_DEFAULT_DAYS).toBeGreaterThanOrEqual(1);
    expect(WATCH_DEFAULT_DAYS).toBeLessThanOrEqual(WATCH_MAX_DAYS);
  });

  it("accepts watch mode with an end date", () => {
    expect(parseConfig(JSON.stringify({ mode: "watch", watchUntil: "2026-11-14T09:00:00.000Z" }))).toMatchObject({ mode: "watch", watchUntil: "2026-11-14T09:00:00.000Z" });
  });

  it("rejects an unknown mode and a bad date", () => {
    expect(() => parseConfig(JSON.stringify({ mode: "off" }))).toThrow(ConfigError);
    expect(() => parseConfig(JSON.stringify({ watchUntil: "soon" }))).toThrow(ConfigError);
    expect(() => parseConfig(JSON.stringify({ watchUntil: 7 }))).toThrow(ConfigError);
  });
});
