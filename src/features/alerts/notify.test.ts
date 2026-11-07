import { describe, expect, it } from "vitest";
import { pickNotifier, type RunProgram } from "./notify.ts";

function recorder() {
  const calls: Array<{ program: string; args: readonly string[] }> = [];
  const run: RunProgram = async (program, args) => {
    calls.push({ program, args });
  };
  return { calls, run };
}

describe("pickNotifier", () => {
  it("uses osascript on macOS and passes the text as arguments, not inside the script", async () => {
    const { calls, run } = recorder();
    const notifier = pickNotifier("darwin", run);
    expect(notifier?.name).toBe("osascript");

    const body = `claude: it's "quoted" \\ and $(echo hi)`;
    await notifier?.send({ title: "agent-guardrails: blocked", body });
    expect(calls).toEqual([
      {
        program: "osascript",
        args: ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", body, "agent-guardrails: blocked"],
      },
    ]);
    // The script text is fixed; none of the notification text is part of it.
    expect(calls[0]?.args.slice(0, 6).join(" ")).not.toContain("quoted");
  });

  it("uses notify-send on Linux, with -- before the text", async () => {
    const { calls, run } = recorder();
    const notifier = pickNotifier("linux", run);
    expect(notifier?.name).toBe("notify-send");
    await notifier?.send({ title: "-t", body: "-rf" });
    expect(calls[0]).toEqual({ program: "notify-send", args: ["--app-name=agent-guardrails", "--", "-t", "-rf"] });
  });

  it("keeps text that starts with a dash from being read as an option on macOS", async () => {
    const { calls, run } = recorder();
    await pickNotifier("darwin", run)?.send({ title: "-title", body: "-body" });
    expect(calls[0]?.args.slice(-2)).toEqual([" -body", " -title"]);
  });

  it("has no notifier for Windows or other systems", () => {
    const { run } = recorder();
    for (const platform of ["win32", "freebsd", "aix"] as const) expect(pickNotifier(platform, run)).toBeNull();
  });

  it("passes a failure on to the caller", async () => {
    const run: RunProgram = async () => {
      throw new Error("spawn osascript ENOENT");
    };
    await expect(pickNotifier("darwin", run)?.send({ title: "t", body: "b" })).rejects.toThrow(/ENOENT/);
  });
});
