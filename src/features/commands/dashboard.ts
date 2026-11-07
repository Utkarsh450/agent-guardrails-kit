import { spawn } from "node:child_process";
import { startDashboard, type RunningDashboard } from "../dashboard/server.ts";
import { CliError } from "./errors.ts";
import { findProjectRoot, type CommandContext } from "./context.ts";

export interface DashboardCommandOptions {
  /** Port to listen on. 0 picks a free one. */
  port?: number;
  /** Open the page in the default browser. */
  open?: boolean;
}

export const DEFAULT_PORT = 4747;

/** Hooks for tests: how to wait, and how to open a browser. */
export interface DashboardHooks {
  waitForStop?: (server: RunningDashboard) => Promise<void>;
  openUrl?: (url: string) => void;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

/** Opens a URL with the system's default handler. Only ever called with the loopback address of this server. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // opening a browser is a convenience; the URL is printed anyway
  }
}

/** `agent-guardrails ui`: a read-only dashboard on 127.0.0.1. Stop it with Ctrl+C. */
export async function runDashboard(ctx: CommandContext, options: DashboardCommandOptions = {}, hooks: DashboardHooks = {}): Promise<number> {
  const { ui } = ctx;
  const root = findProjectRoot(ctx.cwd);
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError(`"${String(options.port)}" is not a valid port. Use a number from 0 to 65535 (0 picks a free port).`);

  ui.intro("agent-guardrails ui", { big: true });
  let server: RunningDashboard;
  try {
    server = await startDashboard({ root, port });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EADDRINUSE") throw new CliError(`Port ${port} is already in use. Pick another with --port <number>, or --port 0 for any free port.`);
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  ui.success(`Dashboard running at ${server.url}`);
  ui.info("It is read-only and only answers on this machine. Press Ctrl+C to stop.");
  if (options.open) (hooks.openUrl ?? openInBrowser)(server.url);

  await (hooks.waitForStop ?? (() => waitForSignal()))(server);
  await server.close();
  ui.info("Dashboard stopped.");
  return 0;
}
