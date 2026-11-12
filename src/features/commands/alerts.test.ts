import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { entryLine, FakeLog } from "../../../tests/helpers/fake-tail-fs.ts";
import { ScriptedUi } from "../../../tests/helpers/scripted-ui.ts";
import type { RunProgram } from "../alerts/index.ts";
import { runAlerts, type AlertsDeps, type AlertsOptions } from "./alerts.ts";

const project = async () => realpath(await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-alerts-")));

/** Each `step` runs when the command goes to sleep (so it plays the part of the guard writing the log). After the last step the command is stopped. */
function run(root: string, ui: ScriptedUi, log: unknown, steps: Array<() => void>, options: AlertsOptions = {}, extra: AlertsDeps = {}) {
  const controller = new AbortController();
  let next = 0;
  const deps: AlertsDeps = {
    fs: log as AlertsDeps["fs"],
    signal: controller.signal,
    utc: true,
    platform: "linux",
    sleep: async () => {
      const step = steps[next];
      next += 1;
      if (step) step();
      else controller.abort();
    },
    ...extra,
  };
  return runAlerts({ cwd: root, ui }, options, deps);
}

function notifier() {
  const calls: Array<{ program: string; args: readonly string[] }> = [];
  const runProgram: RunProgram = async (program, args) => {
    calls.push({ program, args });
  };
  return { calls, runProgram };
}

describe("agent-guardrails-kit alerts", () => {
  it("prints new blocked, asked and watched actions, and not old or allowed ones", async () => {
    const ui = new ScriptedUi([], false);
    const log = new FakeLog(entryLine({ detail: "old command" }));
    const code = await run(await project(), ui, log, [
      () =>
        log.append(
          entryLine() +
            entryLine({ decision: "ask", rule: "unknown-command", detail: "python x.py" }) +
            entryLine({ decision: "ask", rule: "unknown-command", detail: "python y.py", watched: true }) +
            entryLine({ decision: "allow", rule: "allowed", detail: "ls" }),
        ),
    ]);

    expect(code).toBe(0);
    expect(ui.text).toContain("09:41:07  BLOCKED  claude  file-deletion  rm -rf build");
    expect(ui.text).toContain("09:41:07  ASKED    claude  unknown-command  python x.py");
    expect(ui.text).toContain("09:41:07  WATCHED  claude  unknown-command  python y.py");
    expect(ui.text).not.toContain("ALLOWED");
    expect(ui.text).not.toContain("old command");
    expect(ui.text).toMatch(/Watching \.agent-guardrails\/audit\.log/);
    expect(ui.text).toMatch(/Stopped watching/);
  });

  it("shows allowed actions with --all", async () => {
    const ui = new ScriptedUi([], false);
    const log = new FakeLog("");
    await run(await project(), ui, log, [() => log.append(entryLine({ decision: "allow", rule: "allowed", detail: "ls" }))], { all: true });
    expect(ui.text).toContain("09:41:07  ALLOWED  claude  allowed  ls");
  });

  it("waits for a log that is created later", async () => {
    const ui = new ScriptedUi([], false);
    const log = new FakeLog();
    await run(await project(), ui, log, [() => {}, () => log.append(entryLine())]);
    expect(ui.text).toContain("BLOCKED");
  });

  it("removes control characters from what an agent wrote", async () => {
    const ui = new ScriptedUi([], false);
    const log = new FakeLog("");
    await run(await project(), ui, log, [() => log.append(entryLine({ detail: "rm x \u001b]52;c;aGk=\u0007\u001b[2J\n09:00:00  ALLOWED  claude  fake line" }))]);
    expect(ui.text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(ui.text).toContain("BLOCKED");
  });

  it("keeps going and warns once when the log cannot be read", async () => {
    const ui = new ScriptedUi([], false);
    let calls = 0;
    const broken = {
      size: async () => {
        calls += 1;
        if (calls >= 2) throw new Error("EACCES");
        return 0;
      },
      read: async () => Buffer.alloc(0),
    };
    const code = await run(await project(), ui, broken, [() => {}, () => {}, () => {}]);
    expect(code).toBe(0);
    expect(ui.lines.filter((l) => l.includes("Could not read"))).toHaveLength(1);
  });
});

describe("agent-guardrails-kit alerts --notify", () => {
  it("sends one notification per burst, for blocks and asks only", async () => {
    const ui = new ScriptedUi([], false);
    const log = new FakeLog("");
    const { calls, runProgram } = notifier();
    await run(
      await project(),
      ui,
      log,
      [
        () => log.append(entryLine()),
        () => log.append(entryLine() + entryLine({ decision: "ask", rule: "unknown-command" }) + entryLine()),
        () => log.append(entryLine({ decision: "ask", watched: true, rule: "unknown-command" }) + entryLine({ decision: "allow", rule: "allowed" })),
      ],
      { notify: true },
      { run: runProgram },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      program: "notify-send",
      args: ["--app-name=agent-guardrails", "--", "agent-guardrails: blocked", "claude: Deleting files"],
    });
    expect(calls[1]?.args.at(-1)).toBe("3 actions blocked or asked");
    expect(ui.text).toMatch(/desktop notifications on, via notify-send/);
  });

  it("leaves the command out of the notification unless --detail is given", async () => {
    const withoutDetail = notifier();
    const logA = new FakeLog("");
    await run(await project(), new ScriptedUi([], false), logA, [() => logA.append(entryLine())], { notify: true }, { run: withoutDetail.runProgram });
    expect(withoutDetail.calls[0]?.args.at(-1)).toBe("claude: Deleting files");

    const withDetail = notifier();
    const logB = new FakeLog("");
    await run(await project(), new ScriptedUi([], false), logB, [() => logB.append(entryLine())], { notify: true, detail: true }, { run: withDetail.runProgram });
    expect(withDetail.calls[0]?.args.at(-1)).toBe("claude: Deleting files - rm -rf build");
  });

  it("uses osascript on macOS", async () => {
    const { calls, runProgram } = notifier();
    const log = new FakeLog("");
    await run(await project(), new ScriptedUi([], false), log, [() => log.append(entryLine())], { notify: true }, { run: runProgram, platform: "darwin" });
    expect(calls[0]?.program).toBe("osascript");
    expect(calls[0]?.args.at(-2)).toBe("claude: Deleting files");
  });

  it("says so on Windows and keeps printing in the terminal", async () => {
    const ui = new ScriptedUi([], false);
    const log = new FakeLog("");
    const { calls, runProgram } = notifier();
    await run(await project(), ui, log, [() => log.append(entryLine())], { notify: true }, { run: runProgram, platform: "win32" });
    expect(calls).toHaveLength(0);
    expect(ui.text).toMatch(/WARN: Desktop notifications are not supported on win32/);
    expect(ui.text).toContain("BLOCKED");
  });

  it("warns once and stops trying when a notification cannot be shown", async () => {
    const ui = new ScriptedUi([], false);
    const log = new FakeLog("");
    let attempts = 0;
    const failing: RunProgram = async () => {
      attempts += 1;
      throw new Error("spawn notify-send ENOENT");
    };
    await run(await project(), ui, log, [() => log.append(entryLine()), () => log.append(entryLine())], { notify: true }, { run: failing });
    expect(attempts).toBe(1);
    expect(ui.lines.filter((l) => l.includes("Could not send a desktop notification"))).toHaveLength(1);
    expect(ui.lines.filter((l) => l.includes("BLOCKED"))).toHaveLength(2);
  });

  it("sends nothing without --notify", async () => {
    const { calls, runProgram } = notifier();
    const log = new FakeLog("");
    await run(await project(), new ScriptedUi([], false), log, [() => log.append(entryLine())], {}, { run: runProgram });
    expect(calls).toHaveLength(0);
  });
});
