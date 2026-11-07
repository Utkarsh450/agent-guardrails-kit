import picocolors from "picocolors";
import pkg from "../../../package.json" with { type: "json" };

/**
 * A compact 3-row pixel font drawn with half blocks (like the logos of other terminal coding tools).
 * Every glyph is 4 columns wide. Only the letters the banner needs are here.
 * "░" is a soft fill that is drawn dimmer than the solid blocks.
 */
const GLYPHS: Record<string, readonly [string, string, string]> = {
  a: ["█▀▀█", "█▀▀█", "▀  ▀"],
  g: ["█▀▀▀", "█░▀█", "▀▀▀▀"],
  e: ["█▀▀▀", "█▀▀▀", "▀▀▀▀"],
  n: ["█▀▀█", "█░░█", "▀  ▀"],
  t: ["▀██▀", " ██ ", " ▀▀ "],
  u: ["█░░█", "█░░█", "▀▀▀▀"],
  r: ["█▀▀█", "█▀▀▄", "▀  ▀"],
  d: ["█▀▀▄", "█░░█", "▀▀▀ "],
  i: ["▀██▀", " ██ ", "▀▀▀▀"],
  l: ["█░░░", "█░░░", "▀▀▀▀"],
  s: ["█▀▀▀", "▀▀▀█", "▀▀▀▀"],
};

const LEFT_WORD = "agent";
const RIGHT_WORD = "guardrails";
const GAP = "  ";

/** Draws a word in the pixel font, three rows, one column of space between letters. */
export function pixelText(word: string): [string, string, string] {
  const letters = [...word.toLowerCase()].filter((c) => GLYPHS[c]);
  const row = (index: 0 | 1 | 2) => letters.map((c) => GLYPHS[c]?.[index] ?? "").join(" ");
  return [row(0), row(1), row(2)];
}

/** Width of the big banner: "agent", a gap, "guardrails". */
export const BIG_BANNER_WIDTH = pixelText(LEFT_WORD)[0].length + GAP.length + pixelText(RIGHT_WORD)[0].length;

/** Short and light-hearted, like the one-liners other CLIs print at start-up. Kept under 45 characters so the line fits 80 columns. */
export const TAGLINES: readonly string[] = [
  "Your agent asks first. Always.",
  "Trust, but verify. Mostly verify.",
  "Because 'rm -rf' is not a personality.",
  "Fewer oops, more ship.",
  "Seatbelts for your AI pair programmer.",
  "No files were deleted in this session.",
  "Plan first. Approve. Then vibes.",
  "Hooks in. Blunders out.",
  "Teaching robots to say 'may I?'",
  "git push? Not on my watch.",
  "The grown-up in the room, for your agent.",
  "Permission slip, please.",
  "Measure twice, let the agent cut once.",
  "Sleep well. Your .env is safe.",
];

/** A random tagline. `random` is injectable so tests can pick one. */
export function pickTagline(random: () => number = Math.random): string {
  return TAGLINES[Math.min(TAGLINES.length - 1, Math.floor(random() * TAGLINES.length))] ?? "";
}

export function plainBanner(): string {
  return `${pkg.name} v${pkg.version}`;
}

/**
 * The start-up banner: "agent" (grey) and "guardrails" (bright) in pixel letters, then the package name, version and a random one-line joke.
 * Falls back to one plain line when the terminal is narrower than the art.
 */
export function bigBanner(options: { colour: boolean; columns?: number; tagline?: string }): string {
  const { colour, columns = 80, tagline = pickTagline() } = options;
  if (columns < BIG_BANNER_WIDTH + 2) return plainBanner();
  const pc = picocolors.createColors(colour);
  /** Solid blocks in the main colour, the soft fill dimmer. */
  const shade = (line: string, solid: (text: string) => string) =>
    [...line].map((c) => (c === "░" ? pc.dim(pc.gray(c)) : c === " " ? c : solid(c))).join("");
  const left = pixelText(LEFT_WORD);
  const right = pixelText(RIGHT_WORD);
  const art = left.map((part, i) => `${shade(part, pc.gray)}${GAP}${shade(right[i] ?? "", pc.bold)}`);
  return ["", ...art, "", `${pc.cyan("🛡")}  ${pc.bold(plainBanner())} ${pc.dim("—")} ${pc.cyan(tagline)}`, ""].join("\n");
}
