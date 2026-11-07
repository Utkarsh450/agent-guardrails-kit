import { ruleInfo } from "../explain/index.ts";
import type { AuditEntry } from "../hooks/audit.ts";

/**
 * Log entries hold text an agent controls (the command it tried to run). Before any of it reaches the terminal
 * or a desktop notification, control characters are removed, so a command cannot draw fake lines, move the
 * cursor or send commands to the terminal.
 *
 * Removed (as code point ranges, so no invisible characters sit in this source file):
 *  - 0x00 to 0x1f: C0 controls, including ESC and BEL
 *  - 0x7f to 0x9f: DEL and C1 controls
 *  - 0x200b to 0x200f: zero-width characters and direction marks
 *  - 0x2028 to 0x202e: line and paragraph separators and direction overrides
 *  - 0x2060 to 0x206f: invisible formatting characters
 *  - 0xfeff: byte order mark
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];

const isUnsafe = (code: number) => UNSAFE_RANGES.some(([from, to]) => code >= from && code <= to);

/** One line of safe text, at most `max` characters. */
export function cleanText(text: string, max = 200): string {
  let flat = "";
  for (const char of text) flat += isUnsafe(char.codePointAt(0) ?? 0) ? " " : char;
  flat = flat.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

export type Label = "BLOCKED" | "ASKED" | "WATCHED" | "ALLOWED";

export function labelOf(entry: AuditEntry): Label {
  if (entry.decision === "deny") return "BLOCKED";
  if (entry.decision === "ask") return entry.watched ? "WATCHED" : "ASKED";
  return "ALLOWED";
}

/** HH:MM:SS in local time (or UTC, for tests). */
export function formatTime(ts: string, utc = false): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  const pad = (n: number) => String(n).padStart(2, "0");
  return utc
    ? `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
    : `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface FormatOptions {
  utc?: boolean;
  detailMax?: number;
}

/** `09:41:07  BLOCKED  claude  file-deletion  rm -rf build` */
export function formatEntry(entry: AuditEntry, options: FormatOptions = {}): string {
  return [
    formatTime(entry.ts, options.utc),
    labelOf(entry).padEnd(7),
    cleanText(entry.agent, 20),
    cleanText(entry.rule, 40),
    cleanText(entry.detail, options.detailMax ?? 100),
  ]
    .join("  ")
    .trimEnd();
}

/** Blocked actions and asks the person still has to answer. Allowed actions and watch-mode pass-throughs are not worth a popup. */
export function isNotifiable(entry: AuditEntry): boolean {
  return entry.decision === "deny" || (entry.decision === "ask" && !entry.watched);
}

export interface Notification {
  title: string;
  body: string;
}

/** One notification for a group of entries: the rule name only, plus the command when `detail` is on. */
export function notificationFor(entries: readonly AuditEntry[], detail: boolean): Notification | null {
  const [first, ...rest] = entries;
  if (first === undefined) return null;
  if (rest.length > 0) return { title: "agent-guardrails", body: `${entries.length} actions blocked or asked` };
  const verb = first.decision === "deny" ? "blocked" : "asked";
  const rule = cleanText(ruleInfo(first.rule)?.title ?? first.rule, 60);
  const command = detail && first.detail !== "" ? ` - ${cleanText(first.detail, 80)}` : "";
  return { title: `agent-guardrails: ${verb}`, body: `${cleanText(first.agent, 20)}: ${rule}${command}` };
}
