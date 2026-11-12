import path from "node:path";
import {
  DEFAULT_CONFIG,
  hashPlan,
  type GuardConfig,
  type GuardContext,
  type GuardFs,
} from "./guard/guard.mjs";

/**
 * An in-memory project the guard can be evaluated against without touching the real disk.
 * Used by the unit tests and by the in-process self-test (`agent-guardrails-kit test --hooks`).
 */

export const SANDBOX_ROOT = "/proj";
export const SANDBOX_HOME = "/home/tester";

export interface FakeFs extends GuardFs {
  files: Map<string, string>;
  appended: string[];
}

const SYSTEM_DIRS = ["/", "/proj", "/home", "/tmp", "/etc", "/usr", "/var", "/Users", "/bin", "/dev", "/opt"];

export function fakeFs(files: Record<string, string> = {}): FakeFs {
  const map = new Map(Object.entries(files));
  const dirs = new Set<string>(SYSTEM_DIRS);
  for (const file of map.keys()) {
    for (let dir = path.posix.dirname(file); dir !== "/" && dir !== "."; dir = path.posix.dirname(dir)) dirs.add(dir);
  }
  const appended: string[] = [];
  return {
    pathFlavour: "posix",
    files: map,
    appended,
    existsSync: (p) => map.has(p) || dirs.has(p),
    readFileSync: (p) => {
      const content = map.get(p);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return content;
    },
    realpathSync: (p) => p,
    readdirSync: (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const file of map.keys()) {
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0] ?? "");
      }
      if (names.size === 0 && !dirs.has(dir)) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: "ENOENT" });
      return [...names].filter(Boolean);
    },
    lstatSync: (p) => {
      if (map.has(p)) return { isDirectory: () => false, isSymbolicLink: () => false };
      if (dirs.has(p)) return { isDirectory: () => true, isSymbolicLink: () => false };
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    },
    mkdirSync: (p) => {
      for (let dir = p; dir !== "/" && dir !== "."; dir = path.posix.dirname(dir)) dirs.add(dir);
      return undefined;
    },
    statSync: (p) => {
      const content = map.get(p);
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { size: Buffer.byteLength(content, "utf8") };
    },
    appendFileSync: (p, data) => {
      appended.push(data);
      map.set(p, (map.get(p) ?? "") + data);
    },
    writeFileSync: (p, data) => {
      map.set(p, data);
    },
  };
}

export interface ContextOptions {
  config?: Partial<GuardConfig>;
  /** Project files, keyed by absolute path under SANDBOX_ROOT. */
  files?: Record<string, string>;
  /** Pretend the human approved PLAN.md. */
  approved?: boolean;
}

export function makeContext(options: ContextOptions = {}): GuardContext {
  const files = { ...options.files };
  const config: GuardConfig = {
    ...DEFAULT_CONFIG,
    allowCommands: [],
    gitAllow: [...DEFAULT_CONFIG.gitAllow],
    ...options.config,
  };
  if (options.approved) {
    const planPath = `${SANDBOX_ROOT}/${config.planFile}`;
    const plan = files[planPath] ?? "# Plan\n- do the thing\n";
    files[planPath] = plan;
    files[`${SANDBOX_ROOT}/.agent-guardrails/approval.json`] = JSON.stringify({
      version: 1,
      plan: config.planFile,
      sha256: hashPlan("# Plan\n- do the thing\n"),
    });
  }
  return {
    root: SANDBOX_ROOT,
    rootReal: SANDBOX_ROOT,
    cwd: SANDBOX_ROOT,
    home: SANDBOX_HOME,
    config,
    fs: fakeFs(files),
  };
}
