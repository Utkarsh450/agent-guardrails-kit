import { describe, expect, it } from "vitest";
import { BIG_BANNER_WIDTH, TAGLINES, bigBanner, pickTagline, pixelText, plainBanner } from "./banner.ts";

describe("banner", () => {
  it("draws each word three rows tall with the same width on every row", () => {
    for (const word of ["agent", "guardrails"]) {
      const rows = pixelText(word);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.length)).size).toBe(1);
      expect(rows[0].trim().length).toBeGreaterThan(0);
    }
    expect(BIG_BANNER_WIDTH).toBeLessThanOrEqual(78);
  });

  it("shows the package name and version under the big letters", () => {
    const text = bigBanner({ colour: false, columns: 100 });
    expect(text).toContain(plainBanner());
    expect(text).toContain("█");
    expect(text).not.toContain("\u001b[");
  });

  it("uses colour only when asked", () => {
    expect(bigBanner({ colour: true, columns: 100 })).toMatch(/\u001b\[/);
  });

  it("falls back to one plain line in a narrow terminal", () => {
    expect(bigBanner({ colour: false, columns: 40 })).toBe(plainBanner());
  });

  it("prints the name, version and the tagline it was given", () => {
    const text = bigBanner({ colour: false, columns: 100, tagline: "Hooks in. Blunders out." });
    expect(text).toContain(`${plainBanner()} — Hooks in. Blunders out.`);
  });

  it("picks a tagline from the list, and the first and last are reachable", () => {
    expect(pickTagline(() => 0)).toBe(TAGLINES[0]);
    expect(pickTagline(() => 0.999999)).toBe(TAGLINES.at(-1));
    expect(TAGLINES.includes(pickTagline())).toBe(true);
  });

  it("keeps every tagline short enough that the line fits an 80-column terminal", () => {
    for (const tagline of TAGLINES) {
      expect(`🛡  ${plainBanner()} — ${tagline}`.length, tagline).toBeLessThanOrEqual(80);
    }
    expect(new Set(TAGLINES).size).toBe(TAGLINES.length);
  });
});
