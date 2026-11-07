import { describe, expect, it } from "vitest";
import { publishedPackage } from "./package-info.ts";

describe("publishedPackage", () => {
  it("is nothing for a development build, so CI never tries to download an unpublished package", () => {
    expect(publishedPackage({ name: "agent-guardrails-kit", version: "0.0.0" })).toBeUndefined();
    expect(publishedPackage()).toBeUndefined(); // this repo is at 0.0.0 until it is released
  });

  it("names the exact version for a real release", () => {
    expect(publishedPackage({ name: "agent-guardrails-kit", version: "1.2.3" })).toEqual({ packageName: "agent-guardrails-kit", version: "1.2.3" });
  });
});
