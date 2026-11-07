import {
  evaluate,
  normalizeRequest,
  type Decision,
  type GuardContext,
} from "../../src/features/hooks/guard/guard.mjs";
import { makeContext, SANDBOX_ROOT } from "../../src/features/hooks/sandbox.ts";

export { fakeFs, makeContext } from "../../src/features/hooks/sandbox.ts";
export const ROOT = SANDBOX_ROOT;

/** Runs a hook payload through normalize + evaluate. */
export function decide(payload: unknown, ctx: GuardContext = makeContext()): Decision {
  return evaluate(normalizeRequest(payload), ctx);
}

export function shell(command: string, ctx?: GuardContext): Decision {
  return decide({ tool_name: "Bash", tool_input: { command }, cwd: ROOT }, ctx);
}

export function writeFile(filePath: string, content = "x", ctx?: GuardContext, tool = "Write"): Decision {
  return decide({ tool_name: tool, tool_input: { file_path: filePath, content }, cwd: ROOT }, ctx);
}

export function readFile(filePath: string, ctx?: GuardContext): Decision {
  return decide({ tool_name: "Read", tool_input: { file_path: filePath }, cwd: ROOT }, ctx);
}
