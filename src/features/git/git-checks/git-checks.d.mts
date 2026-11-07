export const ALLOW_MARKER: string;
export const LOCKFILES: string[];
export const DEPENDENCY_SECTIONS: string[];
export const INSTALL_SCRIPTS: string[];
export const POPULAR_PACKAGES: string[];
export const SECRET_PATTERNS: Array<{ id: string; name: string; re: RegExp }>;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type GitRunner = (args: string[], input?: string) => GitResult;

export interface Finding {
  line: number;
  id: string;
  name: string;
}

export interface Report {
  errors: string[];
  warnings: string[];
}

export interface DependencyDiff {
  added: Array<{ name: string; section: string; spec: string }>;
  changedSpecs: Array<{ name: string; section: string; spec: string }>;
  scripts: Array<{ name: string; body: string; dangerous: boolean }>;
}

export function entropy(text: string): number;
export function scanLine(line: string): Array<{ id: string; name: string }>;
export function scanText(text: string): Finding[];
export function isSecretPath(rel: string): boolean;
export function makeGit(cwd: string): GitRunner;
export function parseAddedLines(diff: string): Array<{ path: string; lines: Array<{ n: number; text: string }> }>;
export function scanAdded(
  files: Array<{ path: string; lines: Array<{ n: number; text: string }> }>,
  changedPaths: string[],
): { findings: Array<Finding & { path: string }>; secretFiles: string[] };
export function editDistance(a: string, b: string): number;
export function typosquatSuspect(name: string): string | null;
export function unusualSpec(spec: unknown): boolean;
export function diffDependencies(before: unknown, after: unknown): DependencyDiff;
export function dependencyFindings(file: string, diff: DependencyDiff): Report;
export function runPreCommit(git: GitRunner): Report;
export function runPrePush(git: GitRunner, stdin: string): Report;
export function runScanRange(git: GitRunner, range: string): Report;
export function report(title: string, result: Report): string;
