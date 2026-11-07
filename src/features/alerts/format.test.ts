import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../hooks/audit.ts";
import { cleanText, formatEntry, formatTime, isNotifiable, labelOf, notificationFor } from "./format.ts";

const entry = (extra: Partial<AuditEntry> = {}): AuditEntry => ({
  ts: "2026-11-07T09:41:07.000Z",
  agent: "claude",
  tool: "Bash",
  decision: "deny",
  rule: "file-deletion",
  detail: "rm -rf build",
  ...extra,
});

// Built from code points so no invisible characters sit in this source file.
const chr = (...codes: number[]) => String.fromCodePoint(...codes);
const ESC = chr(0x1b);
const BEL = chr(0x07);
const CSI = chr(0x9b);
const RLO = chr(0x202e);
const ZWSP = chr(0x200b);
const LS = chr(0x2028);

/** True when the text holds a control, separator or direction-changing character. */
const hasUnsafe = (text: string) => [...text].some((c) => {
  const code = c.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e);
});

describe("cleanText", () => {
  it("removes escape sequences and other control characters", () => {
    const out = cleanText(`echo ${ESC}[31mred${ESC}[0m ${BEL} ${ESC}]52;c;aGk=${BEL} done ${CSI}2J`);
    expect(hasUnsafe(out)).toBe(false);
    expect(out).toContain("echo");
    expect(out).toContain("done");
  });

  it("keeps a command from starting a fake line", () => {
    const out = cleanText("ls\n09:41:07  ALLOWED  claude  fake\rtext");
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
  });

  it("removes direction-changing, zero-width and separator characters", () => {
    expect(cleanText(`a${RLO}b${ZWSP}c${LS}d`)).toBe("a b c d");
  });

  it("collapses spaces and shortens long text with an ellipsis", () => {
    expect(cleanText("a    b\t\tc")).toBe("a b c");
    const long = cleanText("x".repeat(300), 50);
    expect([...long]).toHaveLength(50);
    expect(long.endsWith("…")).toBe(true);
  });

  it("leaves ordinary text, accents and other scripts alone", () => {
    expect(cleanText("café 日本 rm -rf build")).toBe("café 日本 rm -rf build");
  });
});

describe("labels and times", () => {
  it("names each kind of entry", () => {
    expect(labelOf(entry())).toBe("BLOCKED");
    expect(labelOf(entry({ decision: "ask" }))).toBe("ASKED");
    expect(labelOf(entry({ decision: "ask", watched: true }))).toBe("WATCHED");
    expect(labelOf(entry({ decision: "allow" }))).toBe("ALLOWED");
  });

  it("formats the time of day", () => {
    expect(formatTime("2026-11-07T09:41:07.000Z", true)).toBe("09:41:07");
    expect(formatTime("not a date", true)).toBe("--:--:--");
    expect(formatTime("2026-11-07T09:41:07.000Z")).toMatch(/^\d\d:\d\d:\d\d$/);
  });
});

describe("formatEntry", () => {
  it("prints one aligned line", () => {
    expect(formatEntry(entry(), { utc: true })).toBe("09:41:07  BLOCKED  claude  file-deletion  rm -rf build");
    expect(formatEntry(entry({ decision: "ask", rule: "unknown-command", detail: "python x.py" }), { utc: true })).toBe(
      "09:41:07  ASKED    claude  unknown-command  python x.py",
    );
    expect(formatEntry(entry({ decision: "ask", watched: true, rule: "unknown-command", detail: "python x.py" }), { utc: true })).toBe(
      "09:41:07  WATCHED  claude  unknown-command  python x.py",
    );
  });

  it("leaves no trailing spaces when there is no command", () => {
    expect(formatEntry(entry({ detail: "" }), { utc: true })).toBe("09:41:07  BLOCKED  claude  file-deletion");
  });

  it("cleans text an agent controls", () => {
    const line = formatEntry(entry({ detail: `rm x${ESC}[2J${ESC}]52;c;aGk=${BEL}\n09:00:00  ALLOWED  claude  fake` }), { utc: true });
    expect(hasUnsafe(line)).toBe(false);
    expect(line.split("\n")).toHaveLength(1);
  });

  it("shortens a long command", () => {
    const line = formatEntry(entry({ detail: "x".repeat(500) }), { utc: true, detailMax: 40 });
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(120);
  });
});

describe("what deserves a notification", () => {
  it("is every block and every ask that watch mode did not let through", () => {
    expect(isNotifiable(entry())).toBe(true);
    expect(isNotifiable(entry({ decision: "ask" }))).toBe(true);
    expect(isNotifiable(entry({ decision: "ask", watched: true }))).toBe(false);
    expect(isNotifiable(entry({ decision: "allow" }))).toBe(false);
  });
});

describe("notificationFor", () => {
  it("says nothing for no entries", () => {
    expect(notificationFor([], false)).toBeNull();
  });

  it("names only the agent and the rule by default", () => {
    expect(notificationFor([entry()], false)).toEqual({ title: "agent-guardrails: blocked", body: "claude: Deleting files" });
    expect(notificationFor([entry({ decision: "ask", rule: "unknown-command" })], false)).toEqual({
      title: "agent-guardrails: asked",
      body: "claude: Unknown command",
    });
  });

  it("adds the command only when asked, cleaned and shortened", () => {
    expect(notificationFor([entry()], true)?.body).toBe("claude: Deleting files - rm -rf build");
    const body = notificationFor([entry({ detail: `x${ESC}[2J${"y".repeat(300)}` })], true)?.body ?? "";
    expect(hasUnsafe(body)).toBe(false);
    expect(body.length).toBeLessThan(140);
  });

  it("combines a burst into one notification", () => {
    expect(notificationFor([entry(), entry(), entry()], true)).toEqual({ title: "agent-guardrails", body: "3 actions blocked or asked" });
  });

  it("falls back to the rule id for a rule the catalog does not know", () => {
    expect(notificationFor([entry({ rule: "brand-new-rule" })], false)?.body).toBe("claude: brand-new-rule");
  });
});
