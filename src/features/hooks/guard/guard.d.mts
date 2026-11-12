export const CONFIG_FILE: string;
export const STATE_DIR: string;

export interface GuardConfig {
  version: 1;
  policy: "ask" | "blocklist" | "allowlist";
  allowCommands: string[];
  gitAllow: string[];
  approvalGate: boolean;
  planFile: string;
  auditAllowed: boolean;
  mode: "enforce" | "watch";
  watchUntil: string | null;
  checkpoints: boolean;
}

/** Where checkpoints are kept, relative to the project folder. */
export const CHECKPOINT_DIR: string;
export const CHECKPOINT_LIMITS: Readonly<{ maxFileBytes: number; maxCount: number; maxTotalBytes: number }>;

export const DEFAULT_CONFIG: Readonly<GuardConfig>;

/** True only while mode is "watch" and watchUntil is a real time in the future, at most 30 days away. */
export function watchActive(config: Pick<GuardConfig, "mode" | "watchUntil">, now?: Date): boolean;

export function validateConfig(
  data: unknown,
): { config: GuardConfig; error?: undefined } | { error: string; config?: undefined };

export type DecisionKind = "allow" | "ask" | "deny";

export interface Decision {
  decision: DecisionKind;
  rule: string;
  reason: string;
}

export interface GuardFs {
  /** Which path rules the file system's paths follow. Leave it out to use the machine's own. */
  pathFlavour?: "posix" | "win32";
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  realpathSync(path: string): string;
  readdirSync(path: string): string[];
  mkdirSync(path: string, options?: { recursive?: boolean }): unknown;
  statSync(path: string): { size: number };
  lstatSync(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
  appendFileSync(path: string, data: string, encoding?: "utf8"): void;
  writeFileSync(path: string, data: string, encoding?: "utf8"): void;
}

export interface GuardContext {
  root: string;
  rootReal: string;
  cwd: string;
  home: string;
  config: GuardConfig;
  fs: GuardFs;
  approval?: { approved: boolean; reason: string };
}

export type NormalizedRequest =
  | { kind: "shell"; tool: string; command: string; cwd?: string }
  | { kind: "patch"; tool: string; patch: string; cwd?: string }
  | { kind: "write"; tool: string; paths: string[]; content: string; cwd?: string }
  | { kind: "read"; tool: string; paths: string[]; cwd?: string }
  | { kind: "delete"; tool: string; paths: string[]; cwd?: string }
  | { kind: "other"; tool: string; cwd?: string }
  | { kind: "mcp"; tool: string; cwd?: string }
  | { kind: "invalid"; reason: string };

export interface ShellWord {
  v: string;
  dyn: boolean;
  quoted: boolean;
}

export interface ShellCommand {
  words: ShellWord[];
  redirects: { op: string; target: ShellWord }[];
  pipedIn: boolean;
  pipedOut: boolean;
  stdinText: string;
}

export function lex(src: string, depth?: number, problems?: string[]): ShellCommand[];
export function hashPlan(text: string): string;
export function analyzeShell(command: string, ctx: GuardContext, state?: { cwd: string }, depth?: number): Decision;
export function normalizeRequest(payload: unknown): NormalizedRequest;
export function evaluate(request: NormalizedRequest, ctx: GuardContext): Decision;

export type AgentName = "claude" | "cursor" | "codex" | "qoder";

export interface GuardResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function respond(agent: AgentName, result: Decision): GuardResponse;

export function runGuard(options: {
  stdin: string;
  argv?: string[];
  scriptDir?: string;
  fsImpl?: GuardFs;
  home?: string;
  audit?: boolean;
  /** The current time; tests pass a fixed one. */
  now?: Date;
}): GuardResponse;
