import { describe, expect, it } from "vitest";
import { allCases, formatFailures, runCorpusInProcess, summarize } from "./selftest.ts";

describe("hook corpus (in process)", () => {
  const results = runCorpusInProcess();
  const summary = summarize(results);

  it("has a meaningful number of cases", () => {
    expect(allCases.length).toBeGreaterThan(500);
  });

  it("passes every case", () => {
    expect(summary.failed.length, formatFailures(summary, 60)).toBe(0);
  });
});
