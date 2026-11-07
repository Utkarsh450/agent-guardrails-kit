import { describe, expect, it } from "vitest";
import { entryLine, FakeLog } from "../../../tests/helpers/fake-tail-fs.ts";
import { AuditTail } from "./tail.ts";

const FILE = ".agent-guardrails/audit.log";

describe("AuditTail", () => {
  it("skips what is already in the log and returns what is added", async () => {
    const log = new FakeLog(entryLine({ detail: "old" }));
    const tail = new AuditTail(FILE, log);
    expect(await tail.poll()).toEqual([]);
    expect(await tail.poll()).toEqual([]);

    log.append(entryLine({ detail: "one" }) + entryLine({ detail: "two" }));
    expect((await tail.poll()).map((e) => e.detail)).toEqual(["one", "two"]);
    expect(await tail.poll()).toEqual([]);
  });

  it("holds back a line that is still being written", async () => {
    const log = new FakeLog("");
    const tail = new AuditTail(FILE, log);
    await tail.poll();

    const line = entryLine({ detail: "half" });
    log.append(line.slice(0, 40));
    expect(await tail.poll()).toEqual([]);
    log.append(line.slice(40));
    expect((await tail.poll()).map((e) => e.detail)).toEqual(["half"]);
  });

  it("does not damage a character split across two reads", async () => {
    const log = new FakeLog("");
    const tail = new AuditTail(FILE, log);
    await tail.poll();

    const bytes = Buffer.from(entryLine({ detail: "café" }));
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    log.append(bytes.subarray(0, cut));
    expect(await tail.poll()).toEqual([]);
    log.append(bytes.subarray(cut));
    expect((await tail.poll()).map((e) => e.detail)).toEqual(["café"]);
  });

  it("skips lines that are not valid entries", async () => {
    const log = new FakeLog("");
    const tail = new AuditTail(FILE, log);
    await tail.poll();
    log.append(`not json\n${entryLine({ detail: "ok" })}{"ts":"x"}\n`);
    expect((await tail.poll()).map((e) => e.detail)).toEqual(["ok"]);
  });

  it("starts from the top when the file is replaced by a smaller one", async () => {
    const log = new FakeLog(entryLine() + entryLine() + entryLine());
    const tail = new AuditTail(FILE, log);
    await tail.poll();

    log.replace(entryLine({ detail: "fresh" }));
    expect((await tail.poll()).map((e) => e.detail)).toEqual(["fresh"]);
  });

  it("waits for a log that does not exist yet, then reads it from the start", async () => {
    const log = new FakeLog();
    const tail = new AuditTail(FILE, log);
    expect(await tail.poll()).toEqual([]);
    expect(await tail.poll()).toEqual([]);

    log.append(entryLine({ detail: "first" }));
    expect((await tail.poll()).map((e) => e.detail)).toEqual(["first"]);
  });

  it("copes with the log disappearing and coming back", async () => {
    const log = new FakeLog(entryLine());
    const tail = new AuditTail(FILE, log);
    await tail.poll();
    log.remove();
    expect(await tail.poll()).toEqual([]);
    log.append(entryLine({ detail: "back" }));
    expect((await tail.poll()).map((e) => e.detail)).toEqual(["back"]);
  });

  it("skips ahead to the newest part after a very large burst", async () => {
    const log = new FakeLog("");
    const tail = new AuditTail(FILE, log);
    await tail.poll();

    const line = entryLine({ detail: "x".repeat(100) });
    const count = Math.ceil((1.3 * 1024 * 1024) / line.length);
    log.append(line.repeat(count) + entryLine({ detail: "last" }));
    const entries = await tail.poll();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(count);
    expect(entries.at(-1)?.detail).toBe("last");
  });
});
