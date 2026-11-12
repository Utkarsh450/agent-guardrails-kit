import { describe, expect, it } from "vitest";
import pkg from "../../../package.json" with { type: "json" };
import { publishedPackage } from "./package-info.ts";

describe("publishedPackage", () => {
  it("is nothing for a development build, so CI never tries to download an unpublished package", () => {
    expect(publishedPackage({ name: "agent-guardrails-kit", version: "0.0.0" })).toBeUndefined();
  });

  it("follows this repository's own version: a release is a published package, 0.0.0 is not", () => {
    const own = publishedPackage();
    if (pkg.version === "0.0.0") expect(own).toBeUndefined();
    else expect(own).toEqual({ packageName: pkg.name, version: pkg.version });
  });

  it("names the exact version for a real release", () => {
    expect(publishedPackage({ name: "agent-guardrails-kit", version: "1.2.3" })).toEqual({ packageName: "agent-guardrails-kit", version: "1.2.3" });
  });
});
