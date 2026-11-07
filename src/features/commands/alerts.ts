import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AuditTail, diskTailFs, formatEntry, isNotifiable, notificationFor, pickNotifier, runProgram, type RunProgram, type TailFs } from "../alerts/index.ts";
import { AUDIT_FILE } from "../hooks/audit.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";

export interface AlertsOptions {
  /** Also send a desktop notification for blocked and asked actions. */
  notify?: boolean;
  /** Put the command text in the notification (it is always shown in the terminal). */
  detail?: boolean;
  /** Also show allowed actions (only logged when auditAllowed is on). */
  all?: boolean;
}

/** Things tests replace: the disk, the clock, the way to stop, and the program that shows notifications. */
export interface AlertsDeps {
  fs?: TailFs;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  run?: RunProgram;
  platform?: NodeJS.Platform;
  utc?: boolean;
  intervalMs?: number;
}

const POLL_MS = 500;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `agent-guardrails alerts`: follows the audit log in a spare terminal tab and prints each new blocked or asked
 * action as it happens. Reads only; it never writes to the log or changes any file. Stop it with Ctrl+C.
 * The guard hook itself is not involved: this only reads what the guard already wrote.
 */
export async function runAlerts(ctx: CommandContext, options: AlertsOptions = {}, deps: AlertsDeps = {}): Promise<number> {
  const { ui } = ctx;
  const root = findProjectRoot(ctx.cwd);
  const file = path.join(root, AUDIT_FILE);
  const platform = deps.platform ?? process.platform;
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }).catch(() => undefined));

  const controller = new AbortController();
  const signal = deps.signal ?? controller.signal;
  const stop = () => controller.abort();
  if (deps.signal === undefined) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  try {
    const notifier = options.notify ? pickNotifier(platform, deps.run ?? runProgram) : null;
    if (options.notify && notifier === null) {
      ui.warn(`Desktop notifications are not supported on ${platform} yet. Alerts will be printed here only.`);
    }

    const tail = new AuditTail(file, deps.fs ?? diskTailFs);
    await tail.poll(); // remember where the log ends now, so old entries are not replayed
    ui.info(`Watching ${AUDIT_FILE} for blocked and asked actions${notifier ? ` (desktop notifications on, via ${notifier.name})` : ""}. Press Ctrl+C to stop.`);

    let readWarned = false;
    let notifyFailed = false;
    while (!signal.aborted) {
      await sleep(deps.intervalMs ?? POLL_MS, signal);
      if (signal.aborted) break;

      let entries;
      try {
        entries = await tail.poll();
      } catch (error) {
        if (!readWarned) {
          ui.warn(`Could not read ${AUDIT_FILE} (${message(error)}). Still trying.`);
          readWarned = true;
        }
        continue;
      }

      for (const entry of options.all ? entries : entries.filter((e) => e.decision !== "allow")) {
        ui.print(formatEntry(entry, { utc: deps.utc }));
      }

      if (notifier !== null && !notifyFailed) {
        const note = notificationFor(entries.filter(isNotifiable), options.detail === true);
        if (note !== null) {
          try {
            await notifier.send(note);
          } catch (error) {
            notifyFailed = true;
            ui.warn(`Could not send a desktop notification (${message(error)}). Alerts keep printing here.`);
          }
        }
      }
    }
    ui.info("Stopped watching.");
    return 0;
  } finally {
    if (deps.signal === undefined) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}
