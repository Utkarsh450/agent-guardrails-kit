import { execFile } from "node:child_process";
import type { Notification } from "./format.ts";

/** Starts one program with a list of arguments. Never goes through a shell. */
export type RunProgram = (program: string, args: readonly string[]) => Promise<void>;

export interface Notifier {
  readonly name: string;
  send(note: Notification): Promise<void>;
}

export const runProgram: RunProgram = (program, args) =>
  new Promise((resolve, reject) => {
    execFile(program, [...args], { timeout: 5000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });

/** A leading dash could be read as an option, so it gets a space in front. */
const noDash = (text: string) => (text.startsWith("-") ? ` ${text}` : text);

/**
 * The desktop notifier for this system, or null when there is none.
 *  - macOS: osascript. The text is passed as script arguments, never pasted into the script.
 *  - Linux: notify-send.
 *  - Windows and others: not supported yet.
 */
export function pickNotifier(platform: NodeJS.Platform, run: RunProgram): Notifier | null {
  if (platform === "darwin") {
    return {
      name: "osascript",
      send: ({ title, body }) =>
        run("osascript", [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 1 of argv) with title (item 2 of argv)",
          "-e",
          "end run",
          noDash(body),
          noDash(title),
        ]),
    };
  }
  if (platform === "linux") {
    return { name: "notify-send", send: ({ title, body }) => run("notify-send", ["--app-name=agent-guardrails", "--", title, body]) };
  }
  return null;
}
