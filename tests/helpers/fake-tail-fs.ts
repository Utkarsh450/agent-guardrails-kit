import type { TailFs } from "../../src/features/alerts/tail.ts";

/** An in-memory audit log for tests: append, replace or remove it, and follow it with the real tailer. */
export class FakeLog implements TailFs {
  data: Buffer | null;

  constructor(initial?: string) {
    this.data = initial === undefined ? null : Buffer.from(initial);
  }

  append(text: string | Buffer): void {
    this.data = Buffer.concat([this.data ?? Buffer.alloc(0), typeof text === "string" ? Buffer.from(text) : text]);
  }

  replace(text: string): void {
    this.data = Buffer.from(text);
  }

  remove(): void {
    this.data = null;
  }

  async size(_file: string): Promise<number | null> {
    return this.data === null ? null : this.data.length;
  }

  async read(_file: string, start: number, length: number): Promise<Buffer> {
    if (this.data === null) throw new Error("ENOENT");
    return Buffer.from(this.data.subarray(start, start + length));
  }
}

/** One audit log line, newline included. Defaults to a blocked `rm -rf build` by Claude. */
export function entryLine(extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    ts: "2026-11-07T09:41:07.000Z",
    agent: "claude",
    tool: "Bash",
    decision: "deny",
    rule: "file-deletion",
    detail: "rm -rf build",
    ...extra,
  })}\n`;
}
