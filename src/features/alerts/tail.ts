import { open, stat } from "node:fs/promises";
import { parseAuditLog, type AuditEntry } from "../hooks/audit.ts";

/** The two things the tailer needs from the disk, so tests can use a fake. */
export interface TailFs {
  /** Size in bytes, or null when the file does not exist. */
  size(file: string): Promise<number | null>;
  read(file: string, start: number, length: number): Promise<Buffer>;
}

export const diskTailFs: TailFs = {
  async size(file) {
    try {
      return (await stat(file)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async read(file, start, length) {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

/** Never read more than this in one go; a burst bigger than this skips ahead to the newest part. */
const MAX_READ = 1024 * 1024;
/** A half-written line longer than this is dropped. */
const MAX_PENDING = 64 * 1024;
const NONE = Buffer.alloc(0);

/**
 * Follows the audit log (one JSON object per line) by polling. Reads only; never writes.
 * The first call to `poll` remembers where the log ends and returns nothing, so old entries are not replayed.
 */
export class AuditTail {
  private offset = 0;
  private started = false;
  private pending: Buffer = NONE;

  constructor(
    private readonly file: string,
    private readonly fs: TailFs = diskTailFs,
  ) {}

  /** Entries added since the last call. A line still being written is held back until its newline arrives. */
  async poll(): Promise<AuditEntry[]> {
    const size = await this.fs.size(this.file);
    if (!this.started) {
      this.started = true;
      this.offset = size ?? 0;
      return [];
    }
    if (size === null) {
      // No log (yet, or it was moved away): start from the top when it appears.
      this.offset = 0;
      this.pending = NONE;
      return [];
    }
    if (size < this.offset) {
      // The file was replaced or emptied.
      this.offset = 0;
      this.pending = NONE;
    }
    if (size === this.offset) return [];

    let start = this.offset;
    if (size - start > MAX_READ) {
      start = size - MAX_READ;
      this.pending = NONE;
    }
    const chunk = await this.fs.read(this.file, start, size - start);
    if (chunk.length === 0) return [];
    this.offset = start + chunk.length;

    // Work in bytes until a whole line is there, so a character split across two reads is not damaged.
    const data = Buffer.concat([this.pending, chunk]);
    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      this.pending = data.length > MAX_PENDING ? NONE : data;
      return [];
    }
    this.pending = Buffer.from(data.subarray(lastNewline + 1));
    return parseAuditLog(data.subarray(0, lastNewline + 1).toString("utf8")).entries;
  }
}
