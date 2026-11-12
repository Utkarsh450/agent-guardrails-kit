#!/usr/bin/env node
// agent-guardrails:generated installed copy of the guard. Update it with `agent-guardrails-kit update`; do not edit by hand.
// agent-guardrails guard: a dependency-free PreToolUse hook for Claude Code, Cursor, Codex and Qoder.
//
// It reads one hook payload from stdin, decides allow / ask / deny, and answers in the format the
// calling agent expects. It FAILS CLOSED: any crash, bad input or bad config is a deny.
//
// Installed at <project>/.agent-guardrails/guard.mjs and called like:
//   node .agent-guardrails/guard.mjs --agent claude
//
// Limits (see docs/LIMITS.md): this is a static analysis of the command text. It cannot see what a
// script file does, and a determined agent can still find a way around any pattern list. Treat it
// as one layer next to git hooks, agent permissions and sandboxing, not as a sandbox.

import crypto from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The path rules in use. A real run uses the machine's own (Windows or POSIX). The in-memory test file system is
 * POSIX on every machine, so it says so with `pathFlavour`, and the guard follows it.
 */
let path = nodePath;
function usePathFlavour(fsx) {
  path = fsx?.pathFlavour === "posix" ? nodePath.posix : fsx?.pathFlavour === "win32" ? nodePath.win32 : nodePath;
}

/** True when `target` is `root` or lies inside it. Windows paths ignore letter case, as the file system does. */
function isInsideRoot(target, root) {
  const fold = path.sep === "\\" ? (text) => text.toLowerCase() : (text) => text;
  const a = fold(target);
  const b = fold(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// ───────────────────────────── config ─────────────────────────────

export const CONFIG_FILE = "agent-guardrails.config.json";
export const STATE_DIR = ".agent-guardrails";

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  policy: "ask",
  allowCommands: [],
  gitAllow: ["status", "diff", "log", "show"],
  approvalGate: true,
  planFile: "PLAN.md",
  auditAllowed: false,
  mode: "enforce",
  watchUntil: null,
  checkpoints: true,
});

const POLICIES = ["ask", "blocklist", "allowlist"];
const MODES = ["enforce", "watch"];

/** Validates a parsed config object. Returns { config } or { error }. */
export function validateConfig(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { error: "must be a JSON object" };
  }
  const config = { ...DEFAULT_CONFIG, allowCommands: [], gitAllow: [...DEFAULT_CONFIG.gitAllow] };
  if ("version" in data && data.version !== 1) return { error: "version must be 1" };
  if ("policy" in data) {
    if (!POLICIES.includes(data.policy)) return { error: `policy must be one of ${POLICIES.join(", ")}` };
    config.policy = data.policy;
  }
  for (const key of ["allowCommands", "gitAllow"]) {
    if (key in data) {
      const value = data[key];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
        return { error: `${key} must be an array of non-empty strings` };
      }
      config[key] = value.map((item) => item.trim());
    }
  }
  if (config.allowCommands.some((pattern) => pattern.split(/\s+/)[0] === "*")) {
    return { error: 'allowCommands entries must start with a command name, not "*"' };
  }
  for (const key of ["approvalGate", "auditAllowed", "checkpoints"]) {
    if (key in data) {
      if (typeof data[key] !== "boolean") return { error: `${key} must be true or false` };
      config[key] = data[key];
    }
  }
  if ("planFile" in data) {
    if (typeof data.planFile !== "string" || data.planFile.trim() === "") {
      return { error: "planFile must be a non-empty string" };
    }
    config.planFile = data.planFile.trim();
  }
  if ("mode" in data) {
    if (!MODES.includes(data.mode)) return { error: `mode must be one of ${MODES.join(", ")}` };
    config.mode = data.mode;
  }
  if ("watchUntil" in data) {
    const until = data.watchUntil;
    if (until !== null && (typeof until !== "string" || Number.isNaN(Date.parse(until)))) {
      return { error: "watchUntil must be null or a date and time such as 2026-11-14T09:00:00.000Z" };
    }
    config.watchUntil = until;
  }
  return { config };
}

/** Watch mode can never be set to last longer than this from now. A hand-edited date further away means "enforce". */
const WATCH_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * True only while mode is "watch" AND watchUntil is a real time in the future, at most 30 days away.
 * Anything else (no date, a past date, a bad date, a date years away) means the guard enforces.
 */
export function watchActive(config, now = new Date()) {
  if (config.mode !== "watch" || typeof config.watchUntil !== "string") return false;
  const until = Date.parse(config.watchUntil);
  const current = now.getTime();
  return Number.isFinite(until) && Number.isFinite(current) && until > current && until - current <= WATCH_MAX_MS;
}

/** Asks that watch mode never lets through: changes to rule files, and MCP tools that act on outside systems. */
const WATCH_KEEP_ASKING = new Set(["protected-file", "mcp-action"]);

// ───────────────────────────── decisions ─────────────────────────────

const RANK = { allow: 0, ask: 1, deny: 2 };

function mk(decision, rule, reason, extra = {}) {
  return { decision, rule, reason, overridable: false, ...extra };
}
const ALLOW = () => mk("allow", "allowed", "");

function worst(list) {
  let best = ALLOW();
  for (const item of list) {
    if (RANK[item.decision] > RANK[best.decision]) best = item;
    // "No approved plan" can be fixed by approving; an absolute block cannot, so report the absolute one.
    else if (item.decision === "deny" && best.decision === "deny" && best.rule === "no-approved-plan" && item.rule !== "no-approved-plan") best = item;
    // Among plain allows, remember that the user's allow list was involved (it lets Claude skip its own prompt).
    else if (item.decision === "allow" && best.decision === "allow" && item.rule === "user-allowed") best = item;
  }
  return best;
}

// ───────────────────────────── shell lexer ─────────────────────────────
//
// A small shell-aware splitter. It understands quotes, escapes, $(...) and backticks (their inner
// commands are extracted and analysed too), pipes, ;, &&, ||, &, redirections and here-documents.
// Anything it cannot understand is reported in `problems`, which makes the command "ask".

const MAX_DEPTH = 8;

function newCmd() {
  return { words: [], redirects: [], pipedIn: false, pipedOut: false, stdinText: "" };
}

function newWord() {
  return { v: "", dyn: false, quoted: false };
}

/** Finds the index of the ")" that closes a "(" whose body starts at `start`. Quote aware. */
function findClosingParen(src, start) {
  let depth = 1;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\") {
      i += 1;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
    } else if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findClosingBrace(src, start) {
  let depth = 1;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\") i += 1;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findBacktickEnd(src, start) {
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === "\\") i += 1;
    else if (src[i] === "`") return i;
  }
  return -1;
}

/** Pulls out $(...) and `...` inside free text (here-document bodies) and lexes them. */
function extractSubstitutions(text, depth, problems, commands) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
    } else if (text[i] === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
      const end = findClosingParen(text, i + 2);
      if (end < 0) {
        problems.push("unterminated-substitution");
        return;
      }
      commands.push(...lex(text.slice(i + 2, end), depth + 1, problems));
      i = end;
    } else if (text[i] === "`") {
      const end = findBacktickEnd(text, i + 1);
      if (end < 0) {
        problems.push("unterminated-substitution");
        return;
      }
      commands.push(...lex(text.slice(i + 1, end).replaceAll("\\`", "`"), depth + 1, problems));
      i = end;
    }
  }
}

/**
 * Splits a shell string into simple commands, in execution order (inner substitutions first).
 * Each command: { words: [{v, dyn, quoted}], redirects: [{op, target}], pipedIn, pipedOut, stdinText }.
 */
export function lex(src, depth = 0, problems = []) {
  const commands = [];
  if (depth > MAX_DEPTH) {
    problems.push("too-deep");
    return commands;
  }

  let cur = newCmd();
  let word = null;
  let redirPending = null;
  const heredocs = [];
  let i = 0;
  const n = src.length;

  const ensureWord = () => {
    if (word === null) word = newWord();
    return word;
  };

  const pushWord = () => {
    if (word === null) return;
    if (redirPending !== null) {
      cur.redirects.push({ op: redirPending, target: word });
      if (redirPending === "<<" || redirPending === "<<-") {
        heredocs.push({ delim: word.v, strip: redirPending === "<<-", quoted: word.quoted, cmd: cur });
      } else if (redirPending === "<<<") {
        cur.stdinText += `${word.v}\n`;
      }
      redirPending = null;
    } else {
      cur.words.push(word);
    }
    word = null;
  };

  const endCmd = (pipeOut) => {
    pushWord();
    if (redirPending !== null) {
      problems.push("redirect-without-target");
      redirPending = null;
    }
    if (cur.words.length > 0 || cur.redirects.length > 0) {
      cur.pipedOut = pipeOut;
      commands.push(cur);
      const next = newCmd();
      next.pipedIn = pipeOut;
      cur = next;
    } else {
      cur.pipedIn = pipeOut ? true : cur.pipedIn;
    }
  };

  const readDollar = () => {
    // Called with src[i] === "$". Appends to the current word and advances i.
    const next = src[i + 1];
    const w = ensureWord();
    if (next === "(" && src[i + 2] === "(") {
      const end = src.indexOf("))", i + 3);
      w.dyn = true;
      w.v += end < 0 ? src.slice(i) : src.slice(i, end + 2);
      if (end < 0) problems.push("unterminated-arithmetic");
      i = end < 0 ? n : end + 2;
    } else if (next === "(") {
      const end = findClosingParen(src, i + 2);
      w.dyn = true;
      if (end < 0) {
        problems.push("unterminated-substitution");
        w.v += src.slice(i);
        i = n;
      } else {
        commands.push(...lex(src.slice(i + 2, end), depth + 1, problems));
        w.v += src.slice(i, end + 1);
        i = end + 1;
      }
    } else if (next === "{") {
      const end = findClosingBrace(src, i + 2);
      w.dyn = true;
      if (end < 0) {
        problems.push("unterminated-expansion");
        w.v += src.slice(i);
        i = n;
      } else {
        w.v += src.slice(i, end + 1);
        i = end + 1;
      }
    } else if (next === "'") {
      // $'...' decodes escapes such as \x72\x6d, so its value cannot be known statically.
      const end = src.indexOf("'", i + 2);
      w.dyn = true;
      w.quoted = true;
      w.v += end < 0 ? src.slice(i) : src.slice(i, end + 1);
      if (end < 0) problems.push("unterminated-quote");
      i = end < 0 ? n : end + 1;
    } else if (next !== undefined && /[A-Za-z_0-9@*#?$!-]/.test(next)) {
      let j = i + 1;
      if (/[A-Za-z_]/.test(next)) {
        while (j < n && /[A-Za-z_0-9]/.test(src[j])) j += 1;
      } else {
        j += 1;
      }
      w.dyn = true;
      w.v += src.slice(i, j);
      i = j;
    } else {
      w.v += "$";
      i += 1;
    }
  };

  const readDouble = () => {
    // Called with src[i] === '"'.
    const w = ensureWord();
    w.quoted = true;
    i += 1;
    while (i < n && src[i] !== '"') {
      const c = src[i];
      if (c === "\\" && i + 1 < n) {
        const e = src[i + 1];
        if (e === '"' || e === "\\" || e === "$" || e === "`") w.v += e;
        else if (e !== "\n") w.v += `\\${e}`;
        i += 2;
      } else if (c === "$") {
        readDollar();
      } else if (c === "`") {
        const end = findBacktickEnd(src, i + 1);
        w.dyn = true;
        if (end < 0) {
          problems.push("unterminated-substitution");
          w.v += src.slice(i);
          i = n;
        } else {
          commands.push(...lex(src.slice(i + 1, end).replaceAll("\\`", "`"), depth + 1, problems));
          w.v += src.slice(i, end + 1);
          i = end + 1;
        }
      } else {
        w.v += c;
        i += 1;
      }
    }
    if (i >= n) problems.push("unterminated-quote");
    else i += 1;
  };

  const consumeHeredocs = () => {
    // i points at the "\n" that ended the line holding the here-doc operators.
    i += 1;
    for (const doc of heredocs) {
      const bodyLines = [];
      let closed = false;
      while (i < n) {
        let lineEnd = src.indexOf("\n", i);
        if (lineEnd < 0) lineEnd = n;
        let line = src.slice(i, lineEnd);
        i = Math.min(lineEnd + 1, n);
        const test = doc.strip ? line.replace(/^\t+/, "") : line;
        if (test === doc.delim) {
          closed = true;
          break;
        }
        bodyLines.push(line);
      }
      if (!closed) problems.push("unterminated-heredoc");
      const body = bodyLines.join("\n");
      doc.cmd.stdinText += `${body}\n`;
      if (!doc.quoted) extractSubstitutions(body, depth, problems, commands);
    }
    heredocs.length = 0;
  };

  while (i < n) {
    const c = src[i];

    if (c === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
      } else if (i + 1 < n) {
        const w = ensureWord();
        w.v += src[i + 1];
        w.quoted = true;
        i += 2;
      } else {
        i += 1;
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const w = ensureWord();
      w.quoted = true;
      if (end < 0) {
        problems.push("unterminated-quote");
        w.v += src.slice(i + 1);
        i = n;
      } else {
        w.v += src.slice(i + 1, end);
        i = end + 1;
      }
    } else if (c === '"') {
      readDouble();
    } else if (c === "$") {
      readDollar();
    } else if (c === "`") {
      const end = findBacktickEnd(src, i + 1);
      const w = ensureWord();
      w.dyn = true;
      if (end < 0) {
        problems.push("unterminated-substitution");
        w.v += src.slice(i);
        i = n;
      } else {
        commands.push(...lex(src.slice(i + 1, end).replaceAll("\\`", "`"), depth + 1, problems));
        w.v += src.slice(i, end + 1);
        i = end + 1;
      }
    } else if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      i += 1;
    } else if (c === "\n") {
      pushWord();
      if (heredocs.length > 0) {
        endCmd(false);
        consumeHeredocs();
      } else {
        endCmd(false);
        i += 1;
      }
    } else if (c === "#" && word === null) {
      while (i < n && src[i] !== "\n") i += 1;
    } else if (c === ";") {
      i += src[i + 1] === ";" || src[i + 1] === "&" ? 2 : 1;
      endCmd(false);
    } else if (c === "&" && src[i + 1] !== ">") {
      i += src[i + 1] === "&" ? 2 : 1;
      endCmd(false);
    } else if (c === "|") {
      if (src[i + 1] === "|") {
        i += 2;
        endCmd(false);
      } else {
        i += src[i + 1] === "&" ? 2 : 1;
        endCmd(true);
      }
    } else if (c === "(" || c === ")") {
      if (c === "(" && src[i + 1] === "(") {
        problems.push("arithmetic-command");
        const end = src.indexOf("))", i + 2);
        i = end < 0 ? n : end + 2;
      } else {
        endCmd(false);
        i += 1;
      }
    } else if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const end = findClosingParen(src, i + 2);
      const w = ensureWord();
      w.dyn = true;
      if (end < 0) {
        problems.push("unterminated-substitution");
        w.v += src.slice(i);
        i = n;
      } else {
        commands.push(...lex(src.slice(i + 2, end), depth + 1, problems));
        w.v += src.slice(i, end + 1);
        i = end + 1;
      }
    } else if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      // A bare number right before the operator is a file descriptor, not an argument.
      if (word !== null && /^\d+$/.test(word.v) && !word.quoted) word = null;
      else pushWord();
      let op;
      if (c === "&") op = src.startsWith("&>>", i) ? "&>>" : "&>";
      else if (src.startsWith(">>", i)) op = ">>";
      else if (src.startsWith(">|", i)) op = ">|";
      else if (src.startsWith(">&", i)) op = ">&";
      else if (src.startsWith("<<<", i)) op = "<<<";
      else if (src.startsWith("<<-", i)) op = "<<-";
      else if (src.startsWith("<<", i)) op = "<<";
      else if (src.startsWith("<&", i)) op = "<&";
      else if (src.startsWith("<>", i)) op = "<>";
      else op = c;
      if (redirPending !== null) {
        problems.push("redirect-without-target");
      }
      redirPending = op;
      i += op.length;
    } else if ((c === "{" || c === "}") && word === null && (i + 1 >= n || /[\s;&|)]/.test(src[i + 1]))) {
      i += 1; // bare group braces are syntax, not words
    } else {
      const w = ensureWord();
      w.v += c;
      i += 1;
    }
  }

  endCmd(false);
  if (heredocs.length > 0) problems.push("unterminated-heredoc");
  return commands;
}

// ───────────────────────────── tables ─────────────────────────────

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh"]);

const INTERPRETERS = new Set([
  "python", "node", "nodejs", "deno", "bun", "ruby", "perl", "php", "lua", "osascript", "rscript", "tsx", "ts-node",
]);

const INLINE_FLAGS = {
  python: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  nodejs: ["-e", "--eval", "-p", "--print"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
  php: ["-r"],
  lua: ["-e"],
  osascript: ["-e"],
  rscript: ["-e"],
  bun: ["-e", "--eval"],
  deno: ["eval"],
};

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "in", "esac"]);
const NO_OP_STARTERS = new Set(["for", "case", "select", "function"]);

/** Shell builtins and tiny tools that only change the shell's own state. */
const BUILTIN_SAFE = new Set([
  "export", "unset", "set", "shopt", "readonly", "local", "declare", "typeset", "umask", "ulimit", "hash",
  "wait", "return", "exit", "break", "continue", "shift", "read", "let", "getopts", "alias", "unalias", ":",
  "true", "false", "type",
]);

/** Programs that only read. Extra argument checks are in `readOnlyExtras`. */
const READ_ONLY = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "pwd", "echo", "printf", "test", "[", "[[",
  "which", "whereis", "whoami", "id", "date", "uname", "hostname", "basename", "dirname", "realpath", "readlink",
  "stat", "file", "tree", "du", "df", "sort", "uniq", "cut", "tr", "diff", "cmp", "jq", "comm", "nl", "fold",
  "expand", "column", "rev", "tac", "seq", "sleep", "ps", "pgrep", "lsof", "uptime", "bat", "eza", "exa", "md5sum",
  "shasum", "sha1sum", "sha256sum", "cksum", "od", "xxd", "hexdump", "strings", "cd", "pushd", "popd",
  // PowerShell commands (and their aliases) that only read or move around. They get the same path checks as cat and ls.
  "get-content", "gc", "get-childitem", "gci", "dir", "get-location", "gl", "select-string", "sls", "get-item", "gi",
  "test-path", "resolve-path", "get-date", "write-output", "get-command", "gcm", "get-filehash", "get-process", "gps",
  "set-location", "sl", "push-location", "pop-location",
]);

const VERSION_PROGRAMS = new Set([
  "node", "nodejs", "npm", "pnpm", "yarn", "bun", "deno", "python", "pip", "tsc", "go", "rustc", "cargo", "java",
  "ruby", "php", "docker", "git", "kubectl", "terraform", "make", "gcc", "clang",
]);

const FILE_DELETERS = new Set([
  "rm", "rmdir", "unlink", "shred", "srm", "trash", "trash-put", "rimraf", "del", "erase", "rd", "remove-item", "ri", "truncate",
  "mkfs", "diskutil", "format", "fdisk", "wipefs", "taskkill",
]);

const PROCESS_KILLERS = new Set(["kill", "pkill", "killall", "xkill"]);
const PRIVILEGE = new Set(["sudo", "doas", "su", "pkexec", "runas"]);
const GIT_HOSTING_CLIS = new Set(["gh", "hub", "glab"]);

/** Subcommands that stay blocked even if a project lists them in gitAllow. */
const GIT_NEVER_ALLOWED = new Set([
  "push", "pull", "fetch", "clone", "init", "config", "filter-branch", "filter-repo", "update-ref", "gc", "prune",
  "reflog",
]);

const GIT_SAFE_GLOBALS = new Set([
  "--no-pager", "-P", "--paginate", "-p", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs",
  "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--bare",
]);
const GIT_RISKY_GLOBALS = ["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace", "--super-prefix", "--config-env"];
const GIT_RISKY_FLAGS = ["--output", "--ext-diff", "-O", "--open-files-in-pager", "--textconv"];

const PM_PROGRAMS = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUNNER_PROGRAMS = new Set(["npx", "pnpx", "bunx"]);

const PUBLISH_SUBCOMMANDS = {
  npm: ["publish", "unpublish", "deprecate", "dist-tag", "owner", "access", "token", "adduser", "login", "logout", "team", "org"],
  pnpm: ["publish", "unpublish", "deprecate", "dist-tag", "owner", "access", "token", "adduser", "login", "logout"],
  yarn: ["publish", "npm"],
  bun: ["publish"],
  cargo: ["publish", "yank", "login", "owner"],
  gem: ["push", "yank", "signin", "owner"],
  twine: ["upload"],
  poetry: ["publish"],
  docker: ["push", "login", "logout"],
  helm: ["push"],
  vsce: ["publish"],
  jsr: ["publish"],
  deno: ["publish"],
  uv: ["publish"],
  flit: ["publish"],
};

const INFRA_PROGRAMS = new Set([
  "aws", "gcloud", "az", "kubectl", "helm", "terraform", "tofu", "pulumi", "docker", "podman", "doctl", "heroku",
  "fly", "flyctl", "vercel", "netlify", "wrangler", "supabase", "firebase", "railway", "serverless", "sls",
]);
const INFRA_DESTRUCTIVE_WORD = /^(rm|rmi|prune|delete|destroy|remove|kill|terminate|drop|uninstall|purge|rollback)$/i;
const INFRA_DESTRUCTIVE_PART = /(^|-)(delete|destroy|remove|terminate|purge)(-|$)/i;

const DB_CLIENTS = new Set([
  "psql", "mysql", "mariadb", "sqlite3", "sqlite", "mongosh", "mongo", "redis-cli", "sqlcmd", "duckdb",
  "clickhouse-client", "cockroach", "pg_restore", "mysqldump", "pgcli", "mycli", "litecli", "usql",
]);
const DB_DROPPERS = new Set(["dropdb", "dropuser", "dropdb.exe"]);

/** Programs that run another command we cannot see into. Always ask, whatever the policy or allow list says. */
const OPAQUE_RUNNERS = new Set([
  "watch", "flock", "parallel", "strace", "ltrace", "unshare", "nsenter", "chroot", "taskset", "numactl", "fakeroot",
  "setpriv", "script", "at", "batch", "runuser", "sg", "newgrp", "systemd-run", "ssh", "expect", "tmux", "screen",
  "start-stop-daemon", "gdb", "lldb", "valgrind", "perf",
]);

/** Environment variables that change how other programs run code. Setting them is blocked. */
const RISKY_ENV =
  /^(PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|GIT_.*|PAGER|EDITOR|VISUAL|SHELL|IFS|HOME|PYTHON.*|NODE_OPTIONS|NODE_PATH|PERL5?OPT|PERL5?LIB|RUBYOPT|RUBYLIB|PROMPT_COMMAND|CDPATH|SSH_ASKPASS|SUDO_ASKPASS|NPM_CONFIG_.*|npm_config_.*|XDG_.*)$/;

function riskyEnvAssignment(word) {
  const eq = word.v.indexOf("=");
  return eq > 0 && RISKY_ENV.test(word.v.slice(0, eq));
}

/** Options whose value is a name pattern (exclude lists, globs, regexes), not a path to check. */
const PATTERN_VALUE_OPTIONS = new Set([
  "--exclude", "--include", "--exclude-dir", "--include-dir", "--glob", "--iglob", "-g", "-e", "--regexp", "--ignore",
  "--ignore-glob",
]);

const WRITE_PROGRAMS = new Set(["tee", "touch", "mkdir", "cp", "mv", "ln", "install", "patch", "ditto", "rsync"]);

// ───────────────────────────── regexes ─────────────────────────────

const SQL_DESTRUCTIVE =
  /\b(delete\s+from|drop\s+(table|database|schema|index|view|user|role|collection|extension|function|trigger|sequence|type|materialized)|truncate\s+(table\s+)?[\w."`[]|alter\s+table\s+[^;]*\bdrop\b|flushall|flushdb|dropdatabase|deletemany|deleteone|\.drop\s*\(|db\.\w+\.remove\s*\()/i;
const REDIS_DESTRUCTIVE = /(^|\s)(del|unlink|flushall|flushdb|rename|move)(\s|$)/i;
const MIGRATION_DESTRUCTIVE =
  /(db:drop|db:reset|db:migrate:reset|db:schema:load|schema:drop|migration:revert|migrate:rollback|migrate:down|migrate\s+reset|--force-reset|\balembic\s+downgrade|migrate\s+\S+\s+zero|manage\.py\s+flush|sqlflush)/i;

const DELETE_API =
  /(\bos\.(remove|unlink|rmdir|removedirs)\b|\bshutil\.(rmtree|move)\b|send2trash|\.unlink\s*\(|\.rmdir\s*\(|\brmtree\b|\brmSync\b|\brmdirSync\b|\bunlinkSync\b|\bfs\.(promises\.)?(rm|rmdir|unlink)\b|\brimraf\b|\bremove_tree\b|\bFile\.(delete|unlink)\b|\bFileUtils\b|\bDir\.(rmdir|delete|unlink)\b|(?<![.\w])(unlink|rmdir)\b|\bDeno\.remove\b|\bshred\b|\bnode:fs\b.*\b(rm|unlink)\b)/i;
const SPAWN_API =
  /(\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*)\b|\bpty\.spawn\b|\bchild_process\b|\bexecSync\b|\bexecFile\b|\bspawnSync\b|\bspawn\s*\(|(?<![.\w])exec\s*\(|\bexeca\b|\bBun\.(spawn|\$)|\bDeno\.(run|Command)\b|(?<![.\w])system\s*\(|\bpopen\b|\bproc_open\b|\bshell_exec\b|\bpassthru\b|%x[({]|(?<![.\w])eval\s*\(|__import__|\bimportlib\b)/i;
const PROTECTED_MENTION =
  /(\.agent-guardrails|agent-guardrails\.config|\.githooks|\.git\/|\.git\b(?!hub|ignore|attributes|modules)|\.claude\/(settings|hooks)|\.cursor\/hooks|\.codex\b)/i;
const BASE64_EXEC = /base64\s+(-d|-D|--decode)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i;

// ───────────────────────────── paths ─────────────────────────────

/** Never changeable by an agent: the guardrail machinery itself. */
const HARD_PROTECTED = [
  ".git", ".githooks", ".agent-guardrails", CONFIG_FILE, ".claude/settings.json", ".claude/settings.local.json",
  ".cursor/hooks.json", ".codex", ".gemini/settings.json", ".qoder/settings.json", ".qoder/settings.local.json",
];
/** Changeable only after the user says yes: rules and generated agent files. */
const ASK_PROTECTED = [
  "agent-rules", "agents.md", "claude.md", "gemini.md", ".cursor/rules", ".agents/rules", ".qoder/rules",
  ".github/workflows", ".github/codeowners", ".github/actions",
  // Files that can start programs or change how tools run.
  ".mcp.json", ".cursor/mcp.json", ".vscode/tasks.json", ".vscode/settings.json", ".husky", ".npmrc", ".yarnrc",
  ".yarnrc.yml", "bunfig.toml",
];

const SAFE_DEVICES = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"]);

function matchesEntry(rel, entry) {
  const r = rel.toLowerCase();
  const e = entry.toLowerCase();
  return r === e || r.startsWith(`${e}/`);
}

function isSecretFile(rel) {
  const parts = rel.toLowerCase().split("/");
  const base = parts[parts.length - 1] ?? "";
  if (parts.some((part) => part === ".ssh" || part === ".gnupg")) return true;
  if (parts.includes(".aws") && base === "credentials") return true;
  if (/^\.env($|\.)/.test(base) && !/\.(example|sample|template|dist)$/.test(base)) return true;
  if (/\.(pem|p12|pfx|key|keystore|jks)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(?!.*\.pub$)/.test(base)) return true;
  if (/^\.(netrc|pypirc|pgpass|git-credentials)$/.test(base)) return true;
  return false;
}

/** Turns one shell glob component (like ".e*") into a regular expression. */
function globToRegExp(pattern) {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "[" || ch === "]") re += ch;
    else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`, "i");
}

/**
 * A wildcard such as ".e*" or "*.pem" expands to real file names when the shell runs it. If it would
 * match a secret file in that folder, return that file's name. Only the last path component is expanded.
 */
function globHitsSecret(token, cwd, ctx) {
  const none = { hit: null, listed: false };
  if (!/[*?[]/.test(token)) return none;
  const abs = path.resolve(cwd, expandTilde(token, ctx.home));
  const base = path.basename(abs);
  if (!/[*?[]/.test(base)) return none;
  const dir = path.dirname(abs);
  if (!isInsideRoot(dir, ctx.rootReal)) return none;
  let names;
  let re;
  try {
    names = ctx.fs.readdirSync(dir);
    re = globToRegExp(base);
  } catch {
    return none;
  }
  for (const name of names) {
    if (name.startsWith(".") && !base.startsWith(".")) continue; // plain * never matches dotfiles
    if (!re.test(name)) continue;
    const rel = path.relative(ctx.rootReal, path.join(dir, name)).split(path.sep).join("/");
    if (isSecretFile(rel)) return { hit: name, listed: true };
  }
  return { hit: null, listed: true };
}

/** The real path of an existing file. The native version also expands Windows short names (UTKARS~1) and letter case. */
function realpathOf(fsx, target) {
  const native = fsx.realpathSync.native;
  return typeof native === "function" ? native(target) : fsx.realpathSync(target);
}

function realpathSafe(fsx, target) {
  try {
    return realpathOf(fsx, target);
  } catch {
    let current = target;
    const tail = [];
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.unshift(path.basename(current));
      current = parent;
      try {
        return path.join(realpathOf(fsx, current), ...tail);
      } catch {
        // keep walking up
      }
    }
  }
}

function expandTilde(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/") || (path.sep === "\\" && p.startsWith("~\\"))) return path.join(home, p.slice(2));
  // Git Bash writes Windows drives as /c/Users/... (or /cygdrive/c/...). Turn them into C:\Users\...
  if (path.sep === "\\") {
    const drive = /^\/(?:cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/.exec(p);
    if (drive) return `${drive[1].toUpperCase()}:\\${drive[2] ?? ""}`;
  }
  return p;
}

/** Resolves a path against `cwd` and tells where it lies relative to the project root. */
function pathInfo(target, cwd, ctx) {
  if (target.startsWith("~") && target !== "~" && !target.startsWith("~/") && !(path.sep === "\\" && target.startsWith("~\\"))) {
    // ~user expands to another account's home, which we cannot resolve. Treat it as outside.
    return { abs: target, real: target, inside: false, rel: null };
  }
  const abs = path.resolve(cwd, expandTilde(target, ctx.home));
  const real = realpathSafe(ctx.fs, abs);
  const inside = isInsideRoot(real, ctx.rootReal);
  const rel = inside ? path.relative(ctx.rootReal, real).split(path.sep).join("/") : null;
  return { abs, real, inside, rel };
}

// ───────────────────────────── approval gate ─────────────────────────────

export function hashPlan(text) {
  return crypto.createHash("sha256").update(text.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

/** The approval is valid only while PLAN.md still has the exact content the human approved. */
function approvalState(ctx) {
  if (ctx.approval !== undefined) return ctx.approval;
  let state;
  try {
    const recordPath = path.join(ctx.rootReal, STATE_DIR, "approval.json");
    if (!ctx.fs.existsSync(recordPath)) {
      state = { approved: false, reason: "no approval on record" };
    } else {
      const record = JSON.parse(ctx.fs.readFileSync(recordPath, "utf8"));
      const planPath = path.join(ctx.rootReal, ctx.config.planFile);
      if (record?.version !== 1 || typeof record.sha256 !== "string" || record.plan !== ctx.config.planFile) {
        state = { approved: false, reason: "approval record does not match the configured plan file" };
      } else if (!ctx.fs.existsSync(planPath)) {
        state = { approved: false, reason: `${ctx.config.planFile} does not exist` };
      } else if (hashPlan(ctx.fs.readFileSync(planPath, "utf8")) !== record.sha256) {
        state = { approved: false, reason: `${ctx.config.planFile} changed after it was approved` };
      } else {
        state = { approved: true, reason: "" };
      }
    }
  } catch (error) {
    state = { approved: false, reason: `approval record unreadable (${error.message})` };
  }
  ctx.approval = state;
  return state;
}

function gateWrite(info, ctx) {
  if (!ctx.config.approvalGate) return ALLOW();
  if (info.rel !== null && info.rel.toLowerCase() === ctx.config.planFile.toLowerCase()) return ALLOW();
  const state = approvalState(ctx);
  if (state.approved) return ALLOW();
  return mk(
    "deny",
    "no-approved-plan",
    `No approved plan (${state.reason}). Write the plan to ${ctx.config.planFile}, then ask the user to review it and run \`agent-guardrails-kit approve\`.`,
  );
}

/** Checks one path a tool wants to touch. mode is "read" | "write". */
function checkPath(target, mode, cwd, ctx, { readOnlyProgram = false, skipSecret = false } = {}) {
  if (SAFE_DEVICES.has(target)) return ALLOW();
  const info = pathInfo(target, cwd, ctx);
  if (!info.inside) {
    return mk("deny", "outside-project", `"${target}" is outside the project folder.`);
  }
  const rel = info.rel;
  if (!skipSecret && isSecretFile(rel)) {
    return mk("deny", "secret-file", `"${target}" looks like a secret or credentials file. Do not read or change it.`);
  }
  const writes = mode === "write" || !readOnlyProgram;
  if (writes) {
    if (HARD_PROTECTED.some((entry) => matchesEntry(rel, entry))) {
      return mk("deny", "protected-path", `"${target}" is part of the guardrails and cannot be changed by an agent.`);
    }
    if (ASK_PROTECTED.some((entry) => matchesEntry(rel, entry))) {
      return mk("ask", "protected-file", `"${target}" holds project rules or generated agent files. The user must approve changes.`);
    }
  }
  if (mode === "write") return gateWrite(info, ctx);
  return ALLOW();
}

// ───────────────────────────── command analysis ─────────────────────────────

function canonicalProgram(raw) {
  let name = path.basename(String(raw)).toLowerCase();
  name = name.replace(/\.(exe|cmd|bat|ps1)$/, "");
  if (/^python[\d.]*$/.test(name)) return "python";
  if (/^pip[\d.]*$/.test(name)) return "pip";
  return name;
}

const isOption = (w) => w.v.startsWith("-") && w.v !== "-";
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** True when `words` start with the user's allow pattern (token-prefix match, no dynamic words). */
function matchesAllowPattern(pattern, words) {
  const tokens = pattern.trim().split(/\s+/);
  const star = tokens[tokens.length - 1] === "*";
  const wanted = star ? tokens.slice(0, -1) : tokens;
  if (words.length < wanted.length) return false;
  for (let k = 0; k < wanted.length; k += 1) {
    if (words[k].dyn || words[k].v !== wanted[k]) return false;
  }
  return true;
}

function userAllowed(words, ctx) {
  return ctx.config.allowCommands.some((pattern) => matchesAllowPattern(pattern, words));
}

/** Parses leading wrappers (env, timeout, nohup...). Returns { words } or { decision }. */
function unwrap(words, ctx, state, depth, parts) {
  let w = words;
  for (let guard = 0; guard < 8; guard += 1) {
    while (w.length > 0 && (KEYWORDS.has(w[0].v) || w[0].v === "{" || w[0].v === "}")) w = w.slice(1);
    while (w.length > 0 && ENV_ASSIGN.test(w[0].v)) {
      if (riskyEnvAssignment(w[0])) {
        parts.push(mk("deny", "risky-env", `Setting ${w[0].v.split("=")[0]} can make other programs run unreviewed code.`));
        return { words: [] };
      }
      w = w.slice(1);
    }
    if (w.length === 0) return { words: [] };
    const head = w[0].v;
    if (
      !w[0].dyn &&
      ((!w[0].quoted && (/[*?{}]/.test(head) || head.startsWith("~") || (head.includes("[") && head !== "[" && head !== "[["))) ||
        /[^\x20-\x7e]/.test(head))
    ) {
      parts.push(mk("ask", "dynamic-command", "The command name contains a wildcard, brace expansion or unusual characters, so it cannot be checked."));
      return { words: [] };
    }
    if (w[0].dyn) {
      parts.push(mk("ask", "dynamic-command", "The command name is built from a variable or substitution, so it cannot be checked."));
      return { words: [] };
    }
    const prog = canonicalProgram(w[0].v);
    const rest = w.slice(1);

    if (PRIVILEGE.has(prog)) {
      parts.push(mk("deny", "privilege-escalation", `${prog} is not allowed. Ask the user to run it.`));
      return { words: [] };
    }
    if (prog === "env") {
      let k = 0;
      while (k < rest.length) {
        const t = rest[k].v;
        if (t === "-S" || t.startsWith("--split-string") || (t.startsWith("-S") && t.length > 2)) {
          const value =
            t === "-S" ? rest[k + 1] : { v: t.startsWith("--") ? t.slice(t.indexOf("=") + 1) : t.slice(2), dyn: rest[k].dyn };
          if (!value || value.dyn) parts.push(mk("ask", "dynamic-command", "env -S with a dynamic command cannot be checked."));
          else parts.push(analyzeShell(value.v, ctx, { ...state }, depth + 1));
          return { words: [] };
        }
        if (t === "-u" || t === "-C" || t === "-P") {
          k += 2;
        } else if (ENV_ASSIGN.test(t)) {
          if (riskyEnvAssignment(rest[k])) {
            parts.push(mk("deny", "risky-env", `Setting ${t.split("=")[0]} can make other programs run unreviewed code.`));
            return { words: [] };
          }
          k += 1;
        } else if (isOption(rest[k])) {
          k += 1;
        } else break;
      }
      if (k >= rest.length) {
        parts.push(mk("ask", "env-dump", "`env` prints the environment, which may contain secrets."));
        return { words: [] };
      }
      w = rest.slice(k);
      continue;
    }
    if (prog === "command" || prog === "builtin") {
      if (rest.some((r) => /^-[a-zA-Z]*[vV]/.test(r.v))) return { words: [], lookup: true };
      w = rest.filter((r, idx) => !(idx === 0 && isOption(r)));
      continue;
    }
    if (["nohup", "time", "setsid", "caffeinate", "unbuffer", "exec"].includes(prog)) {
      let k = 0;
      while (k < rest.length && isOption(rest[k])) k += 1;
      w = rest.slice(k);
      continue;
    }
    if (prog === "nice" || prog === "ionice") {
      let k = 0;
      while (k < rest.length && isOption(rest[k])) k += rest[k].v === "-n" || rest[k].v === "-c" ? 2 : 1;
      w = rest.slice(k);
      continue;
    }
    if (prog === "timeout") {
      let k = 0;
      while (k < rest.length && isOption(rest[k])) k += ["-s", "-k", "--signal", "--kill-after"].includes(rest[k].v) ? 2 : 1;
      w = rest.slice(k + 1); // skip the duration
      continue;
    }
    if (prog === "stdbuf") {
      w = rest.filter((r) => !isOption(r));
      continue;
    }
    if (prog === "xargs") {
      let k = 0;
      while (k < rest.length && isOption(rest[k])) {
        k += ["-n", "-I", "-P", "-L", "-d", "-s", "-E", "-a"].includes(rest[k].v) ? 2 : 1;
      }
      const inner = rest.slice(k);
      if (inner.length === 0) return { words: [] };
      w = inner;
      continue;
    }
    if (prog === "trap") {
      for (const arg of rest) {
        if (arg.dyn) parts.push(mk("ask", "dynamic-command", "trap with a dynamic handler cannot be checked."));
        else if (!isOption(arg)) parts.push(analyzeShell(arg.v, ctx, { ...state }, depth + 1));
      }
      return { words: [] };
    }
    if (prog === "eval") {
      const dyn = rest.some((r) => r.dyn);
      if (dyn) parts.push(mk("ask", "dynamic-command", "eval with a dynamic argument cannot be checked."));
      parts.push(analyzeShell(rest.map((r) => r.v).join(" "), ctx, { ...state }, depth + 1));
      return { words: [] };
    }
    return { words: w };
  }
  parts.push(mk("ask", "too-deep", "Too many nested wrappers to check."));
  return { words: [] };
}

function inlineCodeOf(prog, args) {
  const flags = INLINE_FLAGS[prog];
  if (!flags) return [];
  const codes = [];
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k].v;
    const direct = flags.includes(a);
    const combined =
      !direct &&
      /^-[A-Za-z]{2,}$/.test(a) &&
      flags.some((f) => f.length === 2 && f[1] === a[a.length - 1]);
    if ((direct || combined) && k + 1 < args.length) {
      codes.push(args[k + 1]);
      continue;
    }
    for (const flag of flags) {
      if (flag.startsWith("--") && a.startsWith(`${flag}=`)) {
        codes.push({ v: a.slice(flag.length + 1), dyn: args[k].dyn, quoted: args[k].quoted });
        break;
      }
      if (flag.length === 2 && !a.startsWith("--") && a.startsWith(flag) && a.length > 2) {
        codes.push({ v: a.slice(2), dyn: args[k].dyn, quoted: args[k].quoted });
        break;
      }
    }
  }
  return codes;
}

function checkInlineCode(code, label) {
  if (code.dyn) return mk("ask", "dynamic-command", `${label} code is built dynamically and cannot be checked.`);
  const text = code.v;
  if (PROTECTED_MENTION.test(text)) {
    return mk("deny", "protected-path", `${label} code touches guardrail files. Ask the user.`);
  }
  if (DELETE_API.test(text)) {
    return mk("deny", "file-deletion", `${label} code deletes files. Ask the user to run it.`);
  }
  if (SQL_DESTRUCTIVE.test(text)) {
    return mk("deny", "data-delete", `${label} code contains a destructive database statement.`);
  }
  if (SPAWN_API.test(text)) {
    return mk("deny", "inline-code-exec", `${label} code starts other programs, which bypasses command checks.`);
  }
  return mk("ask", "inline-code", `${label} code is not checked beyond known-dangerous calls. The user must approve it.`);
}

// ───────────────────────────── script scanning ─────────────────────────────
// A script file can hide what a typed command would show. Just before a script runs, the guard reads it and blocks
// it when it contains something the rules already forbid. This is a pattern check: imports are not followed and
// disguised code gets through (see docs/LIMITS.md).

const SCRIPT_MAX_BYTES = 256 * 1024;
const SCRIPT_MAX_FILES = 3;
const SHELL_SCRIPT_EXT = /\.(sh|bash|zsh|ksh)$/i;
const CODE_SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|mts|cts|rb|pl|php|lua)$/i;
const SHEBANG_SHELL = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:sh|bash|zsh|dash|ksh|ash)\b/;
const SHEBANG_CODE = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:python[\d.]*|node|nodejs|deno|bun|ruby|perl|php|lua|tsx|ts-node)\b/;
/** Installed dependencies are not scanned. */
const SCRIPT_SKIP_DIR = /(^|\/)(node_modules|\.venv|venv|site-packages)\//;

/**
 * Narrower than the inline-code patterns on purpose: whole project scripts use things like pandas `df.drop(...)`,
 * `shutil.move` or the word "truncate" in comments all the time, and those must not be blocked.
 */
const SCRIPT_DELETE =
  /(\bos\.(remove|unlink|rmdir|removedirs)\b|\bshutil\.rmtree\b|send2trash|\.unlink\s*\(|\.rmdir\s*\(|\brmtree\b|\brmSync\b|\brmdirSync\b|\bunlinkSync\b|\bfs\.(promises\.)?(rm|rmdir|unlink)\b|\brimraf\b|\bremove_tree\b|\bFile\.(delete|unlink)\b|\bFileUtils\.(rm|rm_r|rm_rf|remove|remove_dir|remove_entry|rmdir)\w*|\bDir\.(rmdir|delete|unlink)\b|\bDeno\.remove\b|\bshred\b|\b(unlink|rmdir)\s*\(|import\s*\{[^}]*\b(rm|rmdir|unlink|rmSync|rmdirSync|unlinkSync)\b[^}]*\}\s*from\s*["'](node:)?fs(\/promises)?["'])/i;
const SCRIPT_SQL =
  /\b(delete\s+from\s+[\w."`[\]]+(\s+where\b|\s*[;'"`])|drop\s+(table|database|schema)\b|truncate\s+table\b|alter\s+table\s+[^;\n]*\bdrop\b|flushall\b|flushdb\b|dropdatabase\b)/i;

/** Reads a script for scanning, or returns null: outside the project, a directory, a secret file, binary, or too big. */
function readScriptFile(token, cwd, ctx) {
  if (token.dyn || token.v === "") return null;
  const info = pathInfo(token.v, cwd, ctx);
  if (!info.inside || info.rel === null || isSecretFile(info.rel) || SCRIPT_SKIP_DIR.test(info.rel)) return null;
  try {
    if (ctx.fs.lstatSync(info.real).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    if (ctx.fs.statSync(info.real).size > SCRIPT_MAX_BYTES) return null;
  } catch {
    // size not known here: the length check below still applies
  }
  let text;
  try {
    text = ctx.fs.readFileSync(info.real, "utf8");
  } catch {
    return null;
  }
  if (text.length > SCRIPT_MAX_BYTES || text.includes(String.fromCharCode(0))) return null;
  return { rel: info.rel, text };
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Code in Python, JavaScript, Ruby and so on: the earliest forbidden thing, with its line. */
function scanCode(rel, text) {
  let best = null;
  const checks = [
    [PROTECTED_MENTION, "touches guardrail files"],
    [SCRIPT_DELETE, "deletes files"],
    [SCRIPT_SQL, "contains a destructive database statement"],
  ];
  for (const [pattern, what] of checks) {
    const match = pattern.exec(text);
    if (match && (best === null || match.index < best.index)) best = { index: match.index, what, hit: match[0] };
  }
  if (best === null) return null;
  const hit = best.hit.replace(/\s+/g, " ").slice(0, 40);
  return mk("deny", "script-scan", `${rel} line ${lineOf(text, best.index)} ${best.what} (${hit}). Run it yourself, or tell the user what it should do.`);
}

/** A shell script goes through the same analysis as a typed command. */
function scanShellScript(rel, text, ctx, state, depth) {
  const whole = analyzeShell(text, ctx, { ...state }, depth + 1);
  if (whole.decision !== "deny") return null;
  // Find the first line that is blocked on its own, so the message can say where.
  let line = 0;
  const lines = text.split("\n");
  for (let k = 0; k < lines.length && k < 2000 && line === 0; k += 1) {
    if (lines[k].trim() !== "" && analyzeShell(lines[k], ctx, { ...state }, depth + 1).decision === "deny") line = k + 1;
  }
  return mk("deny", "script-scan", `${rel}${line > 0 ? ` line ${line}` : ""} would be blocked (${whole.rule}): ${whole.reason} Run it yourself, or tell the user what it should do.`);
}

/**
 * Looks at the script files a command is about to run. Returns { deny, note }: a deny decision when a file has a
 * finding, otherwise a note saying what was scanned (or null when nothing was).
 */
function scanScripts(prog, first, args, ctx, state, depth) {
  const candidates = [];
  if (SHELLS.has(prog) || prog === "source" || prog === ".") {
    if (SHELLS.has(prog) && args.some((a) => /^-[a-zA-Z]*c$/.test(a.v))) return { deny: null, note: null };
    const target = args.find((a) => !isOption(a));
    if (target) candidates.push({ token: target, kind: "shell" });
  } else if (INTERPRETERS.has(prog)) {
    if (inlineCodeOf(prog, args).length > 0 || args.some((a) => a.v === "-m")) return { deny: null, note: null };
    for (const a of args) {
      if (candidates.length >= SCRIPT_MAX_FILES) break;
      if (!isOption(a) && !a.dyn && CODE_SCRIPT_EXT.test(a.v)) candidates.push({ token: a, kind: "code" });
    }
  } else if (!first.dyn && first.v.includes("/")) {
    candidates.push({ token: first, kind: "auto" });
  }

  let note = null;
  for (const { token, kind } of candidates) {
    const file = readScriptFile(token, state.cwd, ctx);
    if (file === null) continue;
    let type = kind;
    if (type === "auto") {
      const firstLine = file.text.split("\n", 1)[0];
      if (SHEBANG_SHELL.test(firstLine) || SHELL_SCRIPT_EXT.test(file.rel)) type = "shell";
      else if (SHEBANG_CODE.test(firstLine) || CODE_SCRIPT_EXT.test(file.rel)) type = "code";
      else continue;
    }
    const found = type === "shell" ? scanShellScript(file.rel, file.text, ctx, state, depth) : scanCode(file.rel, file.text);
    if (found !== null) return { deny: found, note: null };
    note = `Scanned ${file.rel}: no file deletion, database drop or guardrail-file edit found. Imports and other files are not followed.`;
  }
  return { deny: null, note };
}

/** Finds the nearest package.json at or above `cwd` (inside the project) and returns its scripts. */
function readScripts(cwd, ctx) {
  let dir = cwd;
  for (let k = 0; k < 20; k += 1) {
    const file = path.join(dir, "package.json");
    try {
      if (ctx.fs.existsSync(file)) {
        const data = JSON.parse(ctx.fs.readFileSync(file, "utf8"));
        return data && typeof data.scripts === "object" && data.scripts !== null ? data.scripts : {};
      }
    } catch {
      return {};
    }
    if (dir === ctx.rootReal || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  return {};
}

/** Classifies what `npm|pnpm|yarn|bun <args>` would do. */
function pmAction(prog, args) {
  let k = 0;
  while (k < args.length && isOption(args[k])) {
    k += ["--filter", "-F", "-C", "--dir", "--prefix", "-w", "--workspace", "--cwd"].includes(args[k].v) ? 2 : 1;
  }
  const sub = args[k]?.v;
  const rest = args.slice(k + 1);
  if (sub === undefined) return prog === "yarn" && args.length === 0 ? { action: "install", sub: "install" } : { action: "read" };
  if (PUBLISH_SUBCOMMANDS[prog]?.includes(sub)) return { action: "publish", sub };

  if (["run", "run-script", "rum", "urn"].includes(sub) || (prog === "bun" && sub === "run")) {
    const script = rest.find((r) => !isOption(r));
    return script ? { action: "script", script: script.v } : { action: "read" };
  }
  if (["test", "t", "tst"].includes(sub)) return { action: "script", script: "test" };
  if (["start", "stop", "restart"].includes(sub)) return { action: "script", script: sub };

  const installLike = ["install", "i", "add", "ci", "install-test", "it", "update", "up", "upgrade", "uninstall", "remove", "rm", "r", "un", "unlink", "link", "ln", "dedupe", "rebuild", "import", "patch", "patch-commit", "approve-builds", "fix"];
  if (installLike.includes(sub) || (prog === "npm" && sub === "audit" && rest.some((r) => r.v === "fix"))) {
    return { action: "install", sub };
  }
  if (["exec", "x", "dlx", "create", "init"].includes(sub) || (prog === "pnpm" && sub === "dlx")) {
    return { action: "exec", sub };
  }
  if (sub === "cache" && rest.some((r) => ["clean", "clear", "rm", "prune"].includes(r.v))) return { action: "cache-clean" };
  if (["prune", "autoclean"].includes(sub)) return { action: "cache-clean" };
  if (sub === "store" && rest.some((r) => ["prune", "rm", "remove"].includes(r.v))) return { action: "cache-clean" };
  if (sub === "version" && rest.length > 0) return { action: "version-bump" };
  if (["config", "set", "get", "c"].includes(sub)) {
    return rest.some((r) => ["set", "delete", "edit", "rm"].includes(r.v)) || sub === "set"
      ? { action: "config-write" }
      : { action: "read" };
  }
  const readSubs = ["ls", "list", "la", "ll", "view", "info", "show", "v", "outdated", "audit", "explain", "why", "root", "bin", "prefix", "help", "search", "docs", "doc", "fund", "licenses", "whoami", "ping", "pack", "-v", "--version"];
  if (readSubs.includes(sub)) return { action: "read" };
  // pnpm/yarn/bun treat an unknown first word as a script name.
  if (prog !== "npm") return { action: "script", script: sub };
  return { action: "unknown", sub };
}

const INSTALL_LIFECYCLE = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepack", "postpack"];

function analyzeScripts(names, cwd, ctx, state, depth) {
  const scripts = readScripts(cwd, ctx);
  for (const name of names) {
    const body = scripts[name];
    if (typeof body !== "string") continue;
    const result = analyzeShell(body, ctx, { ...state }, depth + 1);
    if (result.decision === "deny") {
      return mk("deny", "package-script", `The package script "${name}" would be blocked: ${result.reason}`);
    }
  }
  return null;
}


// ───────────────────────────── recursive searches that would read secrets ─────────────────────────────
//
// `grep -r foo .` reads every file under the folder, including `.env`, without ever naming it. Before such a
// search runs, look (bounded, never following symlinks) for secret files under the folders it would search.
// If one would be read and the command does not exclude it, block with a hint. Pipelines such as
// `find | xargs cat` hand over paths the guard cannot see; that stays a documented limit.

const SECRET_WALK_SKIP = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".nuxt", ".cache", "coverage", "target",
  "vendor", ".venv", "venv", "__pycache__", ".turbo", ".agent-guardrails",
]);
const SECRET_WALK_MAX_ENTRIES = 5000;
const SECRET_WALK_MAX_DEPTH = 8;

/** Programs that print or process file contents; `find -exec` of one of these reads what find lists. */
const CONTENT_READERS = new Set([
  "cat", "head", "tail", "less", "more", "bat", "grep", "egrep", "fgrep", "rg", "ag", "xxd", "od", "hexdump", "strings",
  "base64", "jq", "sort", "uniq", "cut", "awk", "sed", "tr", "wc", "diff", "cmp", "md5sum", "shasum", "sha1sum",
  "sha256sum", "cksum", "curl",
]);

/** Secret files under `dirAbs` as paths relative to it. */
function secretFilesUnder(dirAbs, ctx, skipDirs) {
  const found = [];
  const queue = [{ dir: dirAbs, depth: 0 }];
  let seen = 0;
  while (queue.length > 0 && seen < SECRET_WALK_MAX_ENTRIES) {
    const { dir, depth } = queue.shift();
    let names;
    try {
      names = ctx.fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      seen += 1;
      if (seen > SECRET_WALK_MAX_ENTRIES) break;
      const abs = path.join(dir, name);
      let info;
      try {
        info = ctx.fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (SECRET_WALK_SKIP.has(name) || skipDirs.some((pattern) => globToRegExp(pattern).test(name))) continue;
        if (depth < SECRET_WALK_MAX_DEPTH) queue.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      const rel = path.relative(dirAbs, abs).split(path.sep).join("/");
      if (isSecretFile(rel)) found.push(rel);
    }
  }
  return found;
}

/** Keeps only the secret files the command would really read, given its include/exclude patterns. */
function applyNameFilters(files, { includes = [], excludes = [] }) {
  return files.filter((rel) => {
    const name = rel.split("/").pop() ?? rel;
    const matches = (pattern) => {
      const bare = pattern.replace(/^\*\*\//, "");
      return globToRegExp(bare).test(name) || globToRegExp(pattern).test(rel);
    };
    if (includes.length > 0 && !includes.some(matches)) return false;
    return !excludes.some(matches);
  });
}

function secretReadDecision(label, hits, hint) {
  const shown = hits.slice(0, 3).join(", ");
  return mk("deny", "secret-file", `${label} would read the secret file(s) ${shown}. ${hint}`);
}

/** Splits arguments into option values and positionals for tools that take "pattern path..." arguments. */
function splitSearchArgs(args, valueOptions, patternOptions) {
  const positionals = [];
  const filters = { includes: [], excludes: [], excludeDirs: [] };
  let patternGiven = false;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k].v;
    if (a === "--") {
      positionals.push(...args.slice(k + 1).map((x) => x.v));
      break;
    }
    if (a.startsWith("--")) {
      const [name, inline] = [a.split("=")[0], a.includes("=") ? a.slice(a.indexOf("=") + 1) : undefined];
      const value = inline ?? (valueOptions.has(name) ? args[k + 1]?.v : undefined);
      if (inline === undefined && valueOptions.has(name)) k += 1;
      if (patternOptions.has(name)) patternGiven = true;
      if (value !== undefined) {
        if (name === "--include") filters.includes.push(value);
        else if (name === "--exclude") filters.excludes.push(value);
        else if (name === "--exclude-dir") filters.excludeDirs.push(value);
      }
    } else if (a.startsWith("-") && a !== "-") {
      const letters = a.slice(1);
      const valueLetter = [...letters].findIndex((ch) => valueOptions.has(`-${ch}`));
      if (valueLetter >= 0) {
        const ch = letters[valueLetter];
        if (patternOptions.has(`-${ch}`)) patternGiven = true;
        if (valueLetter === letters.length - 1) k += 1; // the value is the next argument
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, filters, patternGiven };
}

const GREP_VALUE_OPTIONS = new Set([
  "-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--include", "--exclude", "--exclude-dir", "--exclude-from",
  "--file", "--regexp", "--max-count", "--context", "--after-context", "--before-context", "--label", "--binary-files",
  "--color", "--colour", "--directories", "--devices",
]);
const GREP_PATTERN_OPTIONS = new Set(["-e", "-f", "--regexp", "--file"]);

const RG_VALUE_OPTIONS = new Set([
  "-e", "-f", "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "-m", "--max-count", "-A", "-B", "-C",
  "-j", "--threads", "-d", "--max-depth", "-M", "--max-columns", "-E", "--encoding", "--sort", "--sortr", "--pre",
  "--pre-glob", "--colors", "--type-add", "--path-separator", "-r", "--replace", "--regexp", "--file", "--context",
  "--after-context", "--before-context",
]);
const RG_PATTERN_OPTIONS = new Set(["-e", "-f", "--regexp", "--file"]);

function searchRoots(positionals, patternGiven, cwd, ctx, skipFirst) {
  const paths = skipFirst && !patternGiven ? positionals.slice(1) : positionals;
  const roots = (paths.length > 0 ? paths : ["."]).map((p) => path.resolve(cwd, expandTilde(p, ctx.home)));
  return roots.filter((r) => isInsideRoot(r, ctx.rootReal));
}

/** Returns a deny decision when a recursive search would read a secret file, otherwise null. */
function recursiveSecretHit(prog, args, state, ctx) {
  if (args.some((a) => a.dyn)) return null; // already asked about by the dynamic-argument check

  if (prog === "grep" || prog === "egrep" || prog === "fgrep" || prog === "rgrep") {
    const recursive =
      prog === "rgrep" ||
      args.some((a) => /^-[A-Za-z0-9]*[rR][A-Za-z0-9]*$/.test(a.v) || a.v === "--recursive" || a.v === "--dereference-recursive" || a.v === "--directories=recurse");
    if (!recursive) return null;
    const { positionals, filters, patternGiven } = splitSearchArgs(args, GREP_VALUE_OPTIONS, GREP_PATTERN_OPTIONS);
    const roots = searchRoots(positionals, patternGiven, state.cwd, ctx, true);
    const hits = roots.flatMap((root) => applyNameFilters(secretFilesUnder(root, ctx, filters.excludeDirs), filters));
    return hits.length > 0
      ? secretReadDecision(`${prog} -r`, hits, "Add --exclude='.env*' (and similar) or search specific folders instead.")
      : null;
  }

  if (prog === "rg") {
    let unrestricted = 0;
    let hidden = false;
    const globs = { includes: [], excludes: [] };
    let typed = false;
    for (let k = 0; k < args.length; k += 1) {
      const a = args[k].v;
      if (a === "-g" || a === "--glob" || a === "--iglob" || a.startsWith("--glob=") || a.startsWith("--iglob=")) {
        const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[k + 1]?.v;
        if (!a.includes("=")) k += 1;
        if (value?.startsWith("!")) globs.excludes.push(value.slice(1));
        else if (value) globs.includes.push(value);
      } else if (a === "-t" || a === "--type" || a.startsWith("--type=")) {
        typed = true;
        if (!a.includes("=")) k += 1;
      } else if (a === "--hidden" || a === "-.") {
        hidden = true;
      } else if (a === "--unrestricted") {
        unrestricted += 1;
      } else if (/^-[A-Za-z.]+$/.test(a) && !a.startsWith("--")) {
        if (a.includes(".")) hidden = true;
        unrestricted += [...a].filter((ch) => ch === "u").length;
      }
    }
    if (!(hidden || unrestricted >= 2) || typed) return null; // ripgrep skips hidden files (such as .env) by default
    const { positionals, patternGiven } = splitSearchArgs(args, RG_VALUE_OPTIONS, RG_PATTERN_OPTIONS);
    const filesMode = args.some((a) => a.v === "--files");
    const roots = searchRoots(positionals, patternGiven || filesMode, state.cwd, ctx, true);
    const hits = roots.flatMap((root) => applyNameFilters(secretFilesUnder(root, ctx, []), globs));
    return hits.length > 0
      ? secretReadDecision("rg with hidden files", hits, "Add -g '!.env*' (and similar) or search specific folders instead.")
      : null;
  }

  if (prog === "diff" && args.some((a) => /^-[A-Za-z]*r[A-Za-z]*$/.test(a.v) || a.v === "--recursive")) {
    const { positionals, filters } = splitSearchArgs(args, new Set(["-x", "-X", "--exclude", "--exclude-from", "-I", "-L", "--label", "-U", "-C", "-W", "-F"]), new Set());
    for (let k = 0; k < args.length; k += 1) {
      if (args[k].v === "-x" && args[k + 1]) filters.excludes.push(args[k + 1].v);
    }
    const roots = positionals
      .map((p) => path.resolve(state.cwd, expandTilde(p, ctx.home)))
      .filter((r) => isInsideRoot(r, ctx.rootReal));
    const hits = roots.flatMap((root) => applyNameFilters(secretFilesUnder(root, ctx, []), filters));
    return hits.length > 0
      ? secretReadDecision("diff -r", hits, "Exclude them with -x '.env*' or compare specific files instead.")
      : null;
  }
  return null;
}

/** `find ... -exec cat {} +` reads whatever find lists, so check what a reader would be handed. */
function findReaderSecretHit(args, state, ctx) {
  const readerExec = [];
  const starts = [];
  const names = { includes: [], excludes: [] };
  let inExpr = false;
  let negate = false;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k].v;
    if (!inExpr && (a.startsWith("-") || a === "!" || a === "(")) inExpr = true;
    if (!inExpr) {
      starts.push(a);
      continue;
    }
    if (a === "!" || a === "-not") {
      negate = true;
      continue;
    }
    if ((a === "-name" || a === "-iname") && args[k + 1]) {
      (negate ? names.excludes : names.includes).push(args[k + 1].v);
      k += 1;
    } else if (["-exec", "-execdir", "-ok", "-okdir"].includes(a) && args[k + 1]) {
      readerExec.push(canonicalProgram(args[k + 1].v));
    }
    negate = false;
  }
  if (!readerExec.some((name) => CONTENT_READERS.has(name))) return null;
  const roots = (starts.length > 0 ? starts : ["."])
    .map((p) => path.resolve(state.cwd, expandTilde(p, ctx.home)))
    .filter((r) => isInsideRoot(r, ctx.rootReal));
  const hits = roots.flatMap((root) => applyNameFilters(secretFilesUnder(root, ctx, []), names));
  return hits.length > 0
    ? secretReadDecision("find -exec", hits, "Exclude them with ! -name '.env*' or list specific files instead.")
    : null;
}

function classifyGit(args, ctx) {
  let k = 0;
  while (k < args.length && isOption(args[k])) {
    const opt = args[k].v;
    const name = opt.split("=")[0];
    if (GIT_RISKY_GLOBALS.includes(name) || /^-[Cc].+/.test(opt)) {
      return mk("deny", "git-option", `git ${name} can redirect git or run other commands and is not allowed.`);
    }
    if (GIT_SAFE_GLOBALS.has(opt)) k += 1;
    else if (["--version", "-v", "--help", "-h"].includes(opt)) return ALLOW();
    else return mk("deny", "git-option", `git option ${opt} is not allowed.`);
  }
  const sub = args[k];
  if (sub === undefined) return ALLOW();
  if (sub.dyn) return mk("ask", "dynamic-command", "The git subcommand is built dynamically.");
  const name = sub.v.toLowerCase();
  const allowed = ctx.config.gitAllow.map((s) => s.toLowerCase());
  if (!allowed.includes(name) || GIT_NEVER_ALLOWED.has(name)) {
    return mk(
      "deny",
      "git-write",
      `git ${name} is not allowed. Agents may only run: ${allowed.join(", ")}. Tell the user the command and let them run it.`,
    );
  }
  for (const arg of args.slice(k + 1)) {
    const flag = arg.v.split("=")[0];
    if (GIT_RISKY_FLAGS.includes(flag) || /^-O.+/.test(arg.v)) {
      return mk("deny", "git-option", `git ${name} ${flag} can write files or run programs and is not allowed.`);
    }
  }
  return ALLOW();
}

function classifyFind(args, ctx, state, depth, prog) {
  const parts = [];
  if (prog === "find") {
    const secret = findReaderSecretHit(args, state, ctx);
    if (secret) return secret;
  }
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k].v;
    if (a === "-delete") {
      return mk("deny", "file-deletion", "find -delete deletes files. Ask the user to run it.");
    }
    if (/^-(fprint0?|fprintf|fls)$/.test(a)) {
      return mk("deny", "file-write", `find ${a} writes files.`);
    }
    const execFlags = prog === "fd" ? ["-x", "-X", "--exec", "--exec-batch"] : ["-exec", "-execdir", "-ok", "-okdir"];
    if (execFlags.includes(a)) {
      let end = k + 1;
      while (end < args.length && args[end].v !== ";" && args[end].v !== "+" && args[end].v !== "\\;") end += 1;
      const inner = args.slice(k + 1, end).map((x) => ({ ...x, v: x.v === "{}" ? "." : x.v }));
      if (inner.length === 0) continue;
      parts.push(classifyCommand({ words: inner, redirects: [], pipedIn: false, pipedOut: false, stdinText: "" }, ctx, state, depth + 1));
      k = end;
    }
  }
  return parts.length > 0 ? worst(parts) : ALLOW();
}

const RO_EXTRAS = {
  sort: (args) => args.some((a) => a.v === "-o" || a.v.startsWith("--output") || a.v.startsWith("--compress-program")),
  tree: (args) => args.some((a) => a.v === "-o"),
  rg: (args) => args.some((a) => a.v.startsWith("--pre") || a.v.startsWith("--hostname-bin")),
  bat: (args) => args.some((a) => a.v.startsWith("--pager")),
  date: (args) => args.some((a) => a.v === "-s" || a.v.startsWith("--set")),
  hostname: (args) => args.some((a) => !isOption(a)),
  "[": () => false,
};

function classifyDatabase(prog, args, cmd) {
  const text = [...args.map((a) => a.v), cmd.stdinText].join(" ");
  if (args.some((a) => a.dyn)) return mk("ask", "db-client", `${prog} with dynamic arguments cannot be checked.`);
  if (SQL_DESTRUCTIVE.test(text) || (prog === "redis-cli" && REDIS_DESTRUCTIVE.test(text))) {
    return mk("deny", "data-delete", `${prog} would delete data. Ask the user to run it.`);
  }
  return mk("ask", "db-client", `${prog} can change data. The user must approve each database command.`);
}

function checkPatch(text, cwd, ctx) {
  const parts = [];
  for (const line of text.split("\n")) {
    const m = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "Delete File") {
      parts.push(mk("deny", "file-deletion", `Deleting ${m[2]} is not allowed. Ask the user.`));
    } else {
      parts.push(checkPath(m[2].trim(), "write", cwd, ctx));
    }
  }
  if (parts.length === 0) parts.push(mk("ask", "patch-unreadable", "The patch could not be read, so the files it touches are unknown."));
  return worst(parts);
}

/** The arguments of find / fd that are folders to search; -name style patterns are not paths. */
function searchPathArgs(prog, args) {
  if (prog === "find") {
    const end = args.findIndex((a) => a.v.startsWith("-") || a.v === "!" || a.v === "(");
    return end < 0 ? args : args.slice(0, end);
  }
  // fd [pattern] [path...]: the first plain argument is the pattern.
  const plain = args.filter((a) => !isOption(a));
  return plain.slice(1);
}

/**
 * The kit's own command line changes the approval record, the allow list and the generated guardrail files, none of
 * which an agent may touch. Whatever way it is started (directly, through npx, pnpm dlx, node and so on), a
 * state-changing subcommand is blocked for agents. Read-only ones (doctor, explain, report, test) fall through to
 * the normal rules.
 */
const GUARDRAILS_CLI = /^agent-guardrails(?:-kit)?(?:\.mjs|\.js|\.cmd)?(?:@[\w.~^-]+)?$/i;
const GUARDRAILS_MODIFYING = new Set(["init", "update", "sync", "approve", "allow", "preset", "mode", "alerts", "restore", "ui"]);

function guardrailsCliSubcommand(words) {
  for (let k = 0; k < words.length; k += 1) {
    const w = words[k];
    if (w.dyn) continue;
    if (GUARDRAILS_CLI.test(path.basename(w.v))) {
      // The first word that is not an option (or an option's value) is the subcommand.
      for (let j = k + 1; j < words.length; j += 1) {
        const v = words[j].v;
        if (v === "--cwd") {
          j += 1; // skip the folder that belongs to --cwd
          continue;
        }
        if (!v.startsWith("-")) return v.toLowerCase();
      }
      return null;
    }
  }
  return undefined;
}

/** Classifies one simple command. Returns a single decision. */
/** Top-level folders that exist in Git Bash on Windows (as /etc, /usr, /tmp, /c/...) even though C:\etc does not. */
const MSYS_TOP_FOLDERS = new Set([
  "bin", "boot", "dev", "etc", "home", "lib", "lib64", "mingw32", "mingw64", "mnt", "opt", "proc", "root", "run", "sbin",
  "srv", "sys", "tmp", "usr", "var", "cygdrive", "users", "windows", "program files",
]);

/** Does `/top/...` name a real folder, rather than a pattern such as the /foo/ in `grep /foo/`? */
function isRealTopFolder(top, ctx) {
  if (ctx.fs.existsSync(`/${top}`)) return true;
  // On Windows that check fails for /etc and /usr, so a Git Bash drive (/c) or a well-known folder counts as real.
  return path.sep === "\\" && (/^[a-zA-Z]$/.test(top) || MSYS_TOP_FOLDERS.has(top.toLowerCase()));
}

function classifyCommand(cmd, ctx, state, depth) {
  const parts = [];

  // Redirections first: they write or read files whatever the command is.
  for (const r of cmd.redirects) {
    if (r.op === "<<" || r.op === "<<-" || r.op === "<<<") continue;
    const t = r.target;
    if ((r.op === ">&" || r.op === "<&") && /^(\d+|-)$/.test(t.v)) continue;
    const writes = r.op !== "<" && r.op !== "<&";
    if (t.dyn) {
      parts.push(
        /^(~|\$\{?HOME\}?)/.test(t.v)
          ? mk("deny", "outside-project", "The home directory is outside the project folder.")
          : mk("ask", "dynamic-path", "A redirection target is built dynamically and cannot be checked."),
      );
      continue;
    }
    parts.push(checkPath(t.v, writes ? "write" : "read", state.cwd, ctx, { readOnlyProgram: !writes }));
  }

  const prepared = unwrap(cmd.words, ctx, state, depth, parts);
  if (prepared.lookup) return worst(parts);
  const words = prepared.words;
  if (words.length === 0) return worst(parts);

  const first = words[0];
  const prog = canonicalProgram(first.v);
  const args = words.slice(1);
  const allowedByUser = userAllowed(words, ctx);

  if (NO_OP_STARTERS.has(prog)) return worst(parts);

  const cliSub = guardrailsCliSubcommand(words);
  if (typeof cliSub === "string" && GUARDRAILS_MODIFYING.has(cliSub)) {
    parts.push(mk("deny", "guardrails-cli", `agent-guardrails-kit ${cliSub} changes the guardrails themselves or opens a local server (approval, allowed commands, settings, dashboard). Only you may run it; an agent may not approve its own plan.`));
    return worst(parts);
  }

  // Anything that executes text piped into it is blocked.
  if (cmd.pipedIn && (SHELLS.has(prog) || INTERPRETERS.has(prog))) {
    const hasInline = SHELLS.has(prog) ? args.some((a) => /^-[a-zA-Z]*c$/.test(a.v)) : inlineCodeOf(prog, args).length > 0;
    const readsStdin = args.some((a) => a.v === "-" || a.v === "-s") || args.every((a) => isOption(a));
    if (!hasInline && readsStdin) {
      parts.push(mk("deny", "pipe-to-shell", `Piping text into ${prog} runs unreviewed code. Ask the user.`));
      return worst(parts);
    }
  }

  // ── hard blocks ──
  if (FILE_DELETERS.has(prog) || /^mkfs\./.test(prog)) {
    parts.push(mk("deny", "file-deletion", `${prog} deletes or destroys data. Tell the user the command and let them run it.`));
    return worst(parts);
  }
  if (prog === "dd" && args.some((a) => a.v.startsWith("of="))) {
    parts.push(mk("deny", "file-write", "dd with of= overwrites files or devices."));
    return worst(parts);
  }
  if (PROCESS_KILLERS.has(prog)) {
    parts.push(mk("deny", "process-kill", `${prog} stops processes. Ask the user first.`));
    return worst(parts);
  }
  if (GIT_HOSTING_CLIS.has(prog)) {
    parts.push(mk("deny", "github-cli", `${prog} talks to the hosting service and is not allowed. The user runs it.`));
    return worst(parts);
  }
  if (DB_DROPPERS.has(prog)) {
    parts.push(mk("deny", "data-delete", `${prog} deletes a database.`));
    return worst(parts);
  }
  if ((prog === "chmod" || prog === "chown" || prog === "chgrp") && args.some((a) => /^-[a-zA-Z]*R/.test(a.v) || a.v === "--recursive")) {
    parts.push(mk("deny", "recursive-permissions", `${prog} -R changes permissions on a whole tree.`));
    return worst(parts);
  }
  if (prog === "rsync" && args.some((a) => /^--(delete|remove-source-files)/.test(a.v))) {
    parts.push(mk("deny", "file-deletion", "rsync with --delete removes files."));
    return worst(parts);
  }
  if (PUBLISH_SUBCOMMANDS[prog]) {
    const sub = args.find((a) => !isOption(a));
    if (sub && PUBLISH_SUBCOMMANDS[prog].includes(sub.v)) {
      parts.push(mk("deny", "publish", `${prog} ${sub.v} publishes or changes credentials. The user runs it.`));
      return worst(parts);
    }
  }
  if (INFRA_PROGRAMS.has(prog)) {
    const hit = args.find((a) => !isOption(a) && (INFRA_DESTRUCTIVE_WORD.test(a.v) || INFRA_DESTRUCTIVE_PART.test(a.v)));
    if (hit) {
      parts.push(mk("deny", "infra-delete", `${prog} ${hit.v} deletes cloud or container resources. The user runs it.`));
      return worst(parts);
    }
  }
  if (!READ_ONLY.has(prog) && MIGRATION_DESTRUCTIVE.test([prog, ...args.map((a) => a.v)].join(" "))) {
    parts.push(mk("deny", "data-delete", "This migration command resets or drops database data."));
    return worst(parts);
  }

  // ── script files: read them before they run ──
  const scan = scanScripts(prog, first, args, ctx, state, depth);
  if (scan.deny !== null) {
    parts.push(scan.deny);
    return worst(parts);
  }

  // ── shells ──
  if (SHELLS.has(prog)) {
    const cIndex = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a.v));
    if (cIndex >= 0 && args[cIndex + 1]) {
      const script = args[cIndex + 1];
      if (script.dyn) parts.push(mk("ask", "dynamic-command", `${prog} -c with a dynamic script cannot be checked.`));
      else parts.push(analyzeShell(script.v, ctx, { ...state }, depth + 1));
      return worst(parts);
    }
    if (cmd.stdinText.trim() !== "") {
      parts.push(analyzeShell(cmd.stdinText, ctx, { ...state }, depth + 1));
      return worst(parts);
    }
    parts.push(mk("ask", "script-exec", `${scan.note ?? "Running a shell script file is not checked."} The user must approve ${prog} ${args.map((a) => a.v).join(" ")}.`.trim()));
    return worst(parts);
  }
  if (prog === "source" || prog === ".") {
    parts.push(mk("ask", "script-exec", `${scan.note ?? "Sourcing a file runs unchecked commands."} The user must approve it.`));
    return worst(parts);
  }

  // ── apply_patch (Codex) ──
  if (prog === "apply_patch") {
    parts.push(checkPatch(cmd.stdinText || args.map((a) => a.v).join("\n"), state.cwd, ctx));
    return worst(parts);
  }

  // ── git ──
  if (prog === "git") {
    const g = classifyGit(args, ctx);
    parts.push(g);
    if (g.decision === "deny") return worst(parts);
  }

  // ── interpreters with inline code ──
  if (INTERPRETERS.has(prog)) {
    const codes = inlineCodeOf(prog, args);
    if (codes.length > 0) {
      for (const code of codes) parts.push(checkInlineCode(code, `${prog} inline`));
      if (cmd.stdinText.trim() !== "" && SQL_DESTRUCTIVE.test(cmd.stdinText)) {
        parts.push(mk("deny", "data-delete", "Input contains a destructive database statement."));
      }
      return worst(parts);
    }
    if (cmd.stdinText.trim() !== "") {
      parts.push(checkInlineCode({ v: cmd.stdinText, dyn: false }, `${prog} script`));
      return worst(parts);
    }
  }

  // ── database clients ──
  if (DB_CLIENTS.has(prog)) {
    parts.push(classifyDatabase(prog, args, cmd));
    return worst(parts);
  }

  // ── programs that run other commands we cannot see ──
  if (OPAQUE_RUNNERS.has(prog)) {
    parts.push(mk("ask", "runs-command", `${prog} runs another command that cannot be checked. The user must approve it.`));
    return worst(parts);
  }
  if (["awk", "gawk", "mawk", "nawk"].includes(prog)) {
    const program = args.filter((a) => !isOption(a)).map((a) => a.v).join(" ");
    if (/\bsystem\s*\(|\|\s*["']|\|\s*getline|\|&/.test(program)) {
      parts.push(mk("deny", "inline-code-exec", "This awk program starts other programs, which bypasses command checks."));
      return worst(parts);
    }
  }

  // ── recursive searches that would read secret files without naming them ──
  const recursive = recursiveSecretHit(prog, args, state, ctx);
  if (recursive) {
    parts.push(recursive);
    return worst(parts);
  }

  // ── find / fd ──
  if (prog === "find" || prog === "fd" || prog === "fdfind") {
    parts.push(classifyFind(args, ctx, state, depth, prog === "find" ? "find" : "fd"));
  }

  // ── package managers ──
  if (PM_PROGRAMS.has(prog)) {
    const act = pmAction(prog, args);
    if (act.action === "publish") {
      parts.push(mk("deny", "publish", `${prog} ${act.sub} publishes or changes credentials. The user runs it.`));
      return worst(parts);
    }
    if (act.action === "cache-clean") {
      parts.push(mk("deny", "file-deletion", `${prog} cache or store cleaning deletes files. The user runs it.`));
      return worst(parts);
    }
    if (act.action === "version-bump") {
      parts.push(mk("deny", "git-write", `${prog} version edits package.json and may commit and tag. The user runs it.`));
      return worst(parts);
    }
    if (act.action === "install") {
      const bad = analyzeScripts(INSTALL_LIFECYCLE, state.cwd, ctx, state, depth);
      if (bad) {
        parts.push(bad);
        return worst(parts);
      }
      parts.push(mk("ask", "dependency-change", `${prog} ${act.sub} changes installed dependencies. The user must approve it.`));
      return worst(parts);
    }
    if (act.action === "exec") {
      parts.push(mk("ask", "runs-package", `${prog} ${act.sub} downloads and runs package code. The user must approve it.`));
      return worst(parts);
    }
    if (act.action === "config-write") {
      parts.push(mk("ask", "config-change", `${prog} config changes need the user's approval.`));
      return worst(parts);
    }
    if (act.action === "script") {
      const bad = analyzeScripts([`pre${act.script}`, act.script, `post${act.script}`], state.cwd, ctx, state, depth);
      if (bad) {
        parts.push(bad);
        return worst(parts);
      }
      parts.push(unknownCommand(prog, allowedByUser, ctx));
      return finishWithArgs(parts, cmd, prog, args, state, ctx);
    }
    if (act.action === "read") return finishWithArgs(parts, cmd, prog, args, state, ctx, true);
    parts.push(unknownCommand(prog, allowedByUser, ctx));
    return finishWithArgs(parts, cmd, prog, args, state, ctx);
  }
  if (RUNNER_PROGRAMS.has(prog)) {
    parts.push(mk("ask", "runs-package", `${prog} downloads and runs package code. The user must approve it.`));
    return worst(parts);
  }

  // ── file-writing programs go through the approval gate ──
  if (WRITE_PROGRAMS.has(prog) || (prog === "sed" && args.some((a) => /^-[a-zA-Z]*i/.test(a.v) || a.v === "--in-place")) || (prog === "perl" && args.some((a) => /^-[a-zA-Z]*i/.test(a.v)))) {
    const targets = args.filter((a) => !isOption(a));
    for (const t of targets) {
      if (t.dyn) continue;
      const info = pathInfo(t.v, state.cwd, ctx);
      if (info.inside) parts.push(gateWrite(info, ctx));
    }
  }

  // ── known harmless ──
  const extra = RO_EXTRAS[prog];
  if (BUILTIN_SAFE.has(prog)) {
    const risky = args.find((a) => ENV_ASSIGN.test(a.v) && riskyEnvAssignment(a));
    if (risky) parts.push(mk("deny", "risky-env", `Setting ${risky.v.split("=")[0]} can make other programs run unreviewed code.`));
    return worst(parts);
  }
  if (READ_ONLY.has(prog) && !(extra && extra(args))) {
    if (prog === "cd" || prog === "pushd" || prog === "set-location" || prog === "sl" || prog === "push-location") {
      const target = args.find((a) => !isOption(a));
      if (target && !target.dyn && target.v !== "-") {
        const info = pathInfo(target.v, state.cwd, ctx);
        if (info.inside) state.cwd = info.real;
      } else if (target) {
        parts.push(mk("ask", "dynamic-path", "cd to a dynamic or previous directory cannot be checked."));
      }
    }
    return finishWithArgs(parts, cmd, prog, args, state, ctx, true);
  }
  if (VERSION_PROGRAMS.has(prog) && args.length === 1 && ["-v", "--version", "-V", "version"].includes(args[0].v)) {
    return worst(parts);
  }
  if (prog === "git") return finishWithArgs(parts, cmd, prog, args, state, ctx, true);
  if (prog === "find" || prog === "fd" || prog === "fdfind") {
    return finishWithArgs(parts, cmd, prog, searchPathArgs(prog, args), state, ctx, true);
  }

  parts.push(unknownCommand(prog, allowedByUser, ctx));
  return finishWithArgs(parts, cmd, prog, args, state, ctx);
}

/** Applies the user's allow list and the configured policy to a program nobody has classified. */
function unknownCommand(prog, allowedByUser, ctx) {
  if (allowedByUser) return mk("allow", "user-allowed", "");
  if (ctx.config.policy === "blocklist") return ALLOW();
  if (ctx.config.policy === "allowlist") {
    return mk("deny", "not-allowed", `${prog} is not on the allow list. The user can add it to allowCommands in ${CONFIG_FILE}.`);
  }
  return mk("ask", "unknown-command", `${prog} is not a known read-only command. The user must approve it, or add it to allowCommands in ${CONFIG_FILE}.`);
}

/** Path checks for every argument, then the final decision for the command. */
function finishWithArgs(parts, cmd, prog, args, state, ctx, readOnlyProgram = false) {
  const exempt = prog === "echo" || prog === "printf";
  if (!exempt) {
    for (let idx = 0; idx < args.length; idx += 1) {
      const a = args[idx];
      const previous = idx > 0 ? args[idx - 1].v : undefined;
      let t = a.v;
      if (a.dyn) {
        if (/^(~|\$\{?HOME\}?)/.test(t)) {
          parts.push(mk("deny", "outside-project", "The home directory is outside the project folder."));
        } else if (!(isOption(a) && !t.includes("="))) {
          parts.push(mk("ask", "dynamic-path", "An argument is built from a variable or substitution, so the path it points to cannot be checked."));
        }
        continue;
      }
      if (isOption(a)) {
        const eq = t.indexOf("=");
        if (eq < 0) continue;
        if (PATTERN_VALUE_OPTIONS.has(t.slice(0, eq))) continue;
        t = t.slice(eq + 1);
      } else if (previous !== undefined && PATTERN_VALUE_OPTIONS.has(previous)) {
        continue; // the value of --exclude / -g / -e is a pattern, not a path
      }
      if (t === "" || t.includes("://")) continue;
      if (t.startsWith("/") && t !== "/") {
        const top = t.split("/")[1] ?? "";
        // A real top-level folder, or a wildcard/brace that could expand to one, must be checked.
        if (top !== "" && !/[*?[{]/.test(top) && !isRealTopFolder(top, ctx)) continue; // looks like a pattern
      }
      const glob = globHitsSecret(t, state.cwd, ctx);
      if (glob.hit !== null) {
        parts.push(mk("deny", "secret-file", `"${t}" would match the secret file "${glob.hit}". Do not read or change it.`));
        continue;
      }
      // When the folder could be listed and nothing secret matched, the pattern text itself is not judged.
      parts.push(checkPath(t, "read", state.cwd, ctx, { readOnlyProgram, skipSecret: glob.listed }));
    }
  }
  return worst(parts);
}

// ───────────────────────────── shell entry point ─────────────────────────────

export function analyzeShell(command, ctx, state = { cwd: ctx.cwd }, depth = 0) {
  usePathFlavour(ctx.fs);
  if (depth > MAX_DEPTH) return mk("ask", "too-deep", "The command is nested too deeply to check.");
  const parts = [];
  if (BASE64_EXEC.test(command)) {
    parts.push(mk("deny", "obfuscated-exec", "Decoding text and piping it to a shell hides what runs."));
  }
  const problems = [];
  const commands = lex(command, 0, problems);
  if (problems.length > 0) {
    parts.push(
      mk(ctx.config.policy === "allowlist" ? "deny" : "ask", "unanalyzable", `The command uses syntax that cannot be checked safely (${[...new Set(problems)].join(", ")}).`),
    );
  }
  for (const cmd of commands) parts.push(classifyCommand(cmd, ctx, state, depth));
  return worst(parts);
}

// ───────────────────────────── file tools ─────────────────────────────

const SHELL_TOOLS = new Set(["bash", "shell", "run_shell_command", "run_terminal_cmd", "terminal", "execute_command", "powershell", "pwsh"]);
const WRITE_TOOLS = new Set([
  "write", "edit", "multiedit", "notebookedit", "create", "create_file", "write_file", "edit_file", "str_replace_editor",
  "str_replace_based_edit_tool", "str_replace", "insert", "replace_in_file",
]);
const READ_TOOLS = new Set(["read", "grep", "glob", "ls", "view", "read_file", "list_directory", "list_dir", "search", "notebookread"]);
const DELETE_TOOLS = new Set(["delete", "remove", "delete_file", "remove_file"]);
/** MCP tool names that read; anything else that sounds like an action needs the user's approval. */
const MCP_ACTION_WORDS = new Set([
  "delete", "remove", "write", "create", "update", "edit", "push", "merge", "exec", "execute", "run", "shell",
  "command", "drop", "truncate", "kill", "send", "post", "publish", "deploy", "move", "rename", "upload", "commit",
  "put", "patch", "set", "add", "install", "start", "stop", "close", "reopen", "assign", "approve", "comment",
  "submit", "trigger", "cancel", "revoke", "grant", "invite", "transfer", "archive", "lock", "unlock", "enable",
  "disable", "apply", "replace", "insert", "save", "import", "fork", "reset", "restart", "terminate", "destroy",
]);

/** True when the tool name contains a whole word that means "change something" (camelCase and snake_case aware). */
function looksLikeMcpAction(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => MCP_ACTION_WORDS.has(word));
}

function pathsFromInput(input) {
  const keys = ["file_path", "path", "filePath", "notebook_path", "target_file", "filename", "directory", "dir"];
  const out = [];
  for (const key of keys) if (typeof input?.[key] === "string" && input[key] !== "") out.push(input[key]);
  if (Array.isArray(input?.paths)) for (const p of input.paths) if (typeof p === "string") out.push(p);
  return out;
}

function contentFromInput(input) {
  const keys = ["content", "new_string", "new_str", "text", "file_text", "contents"];
  const chunks = [];
  for (const key of keys) if (typeof input?.[key] === "string") chunks.push(input[key]);
  if (Array.isArray(input?.edits)) {
    for (const edit of input.edits) if (typeof edit?.new_string === "string") chunks.push(edit.new_string);
  }
  return chunks.join("\n");
}

function checkWrittenContent(target, content, ctx) {
  if (content === "") return ALLOW();
  const base = path.basename(target).toLowerCase();
  const isSql = base.endsWith(".sql") || /(^|\/)(migrations?|prisma|drizzle)\//i.test(target.replaceAll("\\", "/"));
  if (isSql && SQL_DESTRUCTIVE.test(content)) {
    return mk("deny", "destructive-sql-file", "Migrations and SQL files must not contain DROP, TRUNCATE or DELETE statements. Describe the need to the user instead.");
  }
  if (base === "package.json") {
    const m = /"(pre|post)?(install|prepare|publish|pack)"\s*:\s*"([^"]*)"/i.exec(content);
    if (m) {
      const script = analyzeShell(m[3].replaceAll('\\"', '"'), ctx, { cwd: ctx.cwd }, 1);
      if (script.decision === "deny" || /\b(curl|wget)\b/i.test(m[3])) {
        return mk("deny", "lifecycle-script", "Install and publish scripts that delete files or download code are not allowed.");
      }
    }
  }
  return ALLOW();
}

// ───────────────────────────── request handling ─────────────────────────────

/** Turns an agent's hook payload into { kind, ... }. */
export function normalizeRequest(payload) {
  if (payload === null || typeof payload !== "object") return { kind: "invalid", reason: "payload is not an object" };
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : typeof payload.toolName === "string" ? payload.toolName : "";
  const input = payload.tool_input ?? payload.toolInput ?? {};
  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : Array.isArray(payload.workspace_roots) && typeof payload.workspace_roots[0] === "string" ? payload.workspace_roots[0] : undefined;

  if (tool === "") {
    if (typeof payload.command === "string") return { kind: "shell", tool: "shell", command: payload.command, cwd };
    if (typeof payload.file_path === "string") return { kind: "read", tool: "read", paths: [payload.file_path], cwd };
    return { kind: "invalid", reason: "no tool name, command or file path in the payload" };
  }

  const lower = tool.toLowerCase();
  const parsedInput = typeof input === "string" ? safeJson(input) : input;

  if (SHELL_TOOLS.has(lower)) {
    const command = parsedInput?.command ?? parsedInput?.cmd;
    if (typeof command !== "string") return { kind: "invalid", reason: `${tool} call has no command` };
    // In PowerShell a backslash separates folders. The shell rules used here would read it as an escape and turn
    // ..\..\x into a file inside the project, so for PowerShell it is read as the slash it stands for.
    const analysed = lower === "powershell" || lower === "pwsh" ? command.replaceAll("\\", "/") : command;
    return { kind: "shell", tool, command: analysed, cwd };
  }
  if (lower === "apply_patch") {
    const text = parsedInput?.command ?? parsedInput?.patch ?? parsedInput?.input;
    return typeof text === "string" ? { kind: "patch", tool, patch: text, cwd } : { kind: "invalid", reason: "apply_patch call has no patch text" };
  }
  if (DELETE_TOOLS.has(lower)) return { kind: "delete", tool, paths: pathsFromInput(parsedInput), cwd };
  if (WRITE_TOOLS.has(lower)) {
    const paths = pathsFromInput(parsedInput);
    return paths.length > 0
      ? { kind: "write", tool, paths, content: contentFromInput(parsedInput), cwd }
      : { kind: "invalid", reason: `${tool} call has no file path` };
  }
  if (READ_TOOLS.has(lower)) return { kind: "read", tool, paths: pathsFromInput(parsedInput), cwd };
  if (lower.startsWith("mcp__") || lower.startsWith("mcp:")) return { kind: "mcp", tool, cwd };
  return { kind: "other", tool, cwd };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Decides one normalized request. ctx = { root, rootReal, cwd, home, config, fs }. */
export function evaluate(request, ctx) {
  usePathFlavour(ctx.fs);
  switch (request.kind) {
    case "invalid":
      return mk("deny", "unrecognized-input", `The hook input could not be understood (${request.reason}).`);
    case "other":
      return ALLOW();
    case "mcp": {
      // MCP tools cannot be inspected. Ones that sound like reads pass; ones that sound like actions ask.
      const name = request.tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/i, "").replace(/^mcp:/i, "");
      return looksLikeMcpAction(name)
        ? mk("ask", "mcp-action", `The MCP tool "${request.tool}" looks like it changes something and cannot be checked. The user must approve it.`)
        : ALLOW();
    }
    case "delete":
      return mk("deny", "file-deletion", "Deleting files is not allowed. Tell the user the file and let them delete it.");
    case "shell": {
      const cwdInfo = pathInfo(request.cwd ?? ctx.cwd, ctx.cwd, ctx);
      if (!cwdInfo.inside) return mk("deny", "outside-project", "The working directory is outside the project folder.");
      return analyzeShell(request.command, ctx, { cwd: cwdInfo.real });
    }
    case "patch":
      return checkPatch(request.patch, request.cwd ?? ctx.cwd, ctx);
    case "read":
    case "write": {
      const base = request.cwd ?? ctx.cwd;
      const parts = [];
      for (const target of request.paths) {
        // Reading a protected file (for example .git/config) is fine; only secrets and outside paths are blocked.
        parts.push(checkPath(target, request.kind, base, ctx, { readOnlyProgram: request.kind === "read" }));
        if (request.kind === "write") parts.push(checkWrittenContent(target, request.content ?? "", ctx));
      }
      return worst(parts);
    }
    default:
      return mk("deny", "unrecognized-input", "Unknown request kind.");
  }
}

// ───────────────────────────── agent output ─────────────────────────────

const AGENTS = ["claude", "cursor", "codex", "qoder"];

function messages(result) {
  const user = `agent-guardrails blocked this (${result.rule}): ${result.reason}`;
  const askUser = `agent-guardrails needs your approval (${result.rule}): ${result.reason}`;
  const agent =
    "Do not retry this or look for a workaround. Tell the user the exact command and why, then wait for their answer.";
  return { user, askUser, agent };
}

/** Builds { exitCode, stdout, stderr } for the calling agent. */
export function respond(agent, result) {
  let decision = result.decision;
  let reason = result.reason;
  if (decision === "ask" && agent === "codex") {
    // Codex hooks cannot ask. Deny and tell the agent to ask in chat.
    decision = "deny";
    reason = `${reason} (Codex cannot prompt, so ask the user in chat first.)`;
  }
  const msg = messages({ ...result, reason });

  if (decision === "allow") {
    if (agent === "cursor") return { exitCode: 0, stdout: `${JSON.stringify({ permission: "allow" })}\n`, stderr: "" };
    if ((agent === "claude" || agent === "qoder") && result.rule === "user-allowed") {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Allowed by allowCommands in agent-guardrails.config.json" } })}\n`,
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  if (decision === "ask") {
    if (agent === "cursor") {
      return { exitCode: 0, stdout: `${JSON.stringify({ permission: "ask", user_message: msg.askUser, agent_message: msg.agent })}\n`, stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: msg.askUser } })}\n`,
      stderr: "",
    };
  }

  if (agent === "cursor") {
    return { exitCode: 2, stdout: `${JSON.stringify({ permission: "deny", user_message: msg.user, agent_message: msg.agent })}\n`, stderr: `${msg.user}\n` };
  }
  return { exitCode: 2, stdout: "", stderr: `${msg.user}\n${msg.agent}\n` };
}

// ───────────────────────────── audit log ─────────────────────────────

const AUDIT_MAX_BYTES = 10 * 1024 * 1024;

function writeAudit(ctx, agent, request, result, watched = false) {
  try {
    if (result.decision === "allow" && !ctx.config.auditAllowed) return;
    const fsx = ctx.fs;
    const dir = path.join(ctx.rootReal, STATE_DIR);
    fsx.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "audit.log");
    try {
      if (fsx.statSync(file).size > AUDIT_MAX_BYTES) return; // never delete or rotate; `report` warns about size
    } catch {
      // no log yet
    }
    const detail =
      request.kind === "shell" ? request.command : request.kind === "patch" ? request.patch : Array.isArray(request.paths) ? request.paths.join(", ") : "";
    const entry = {
      ts: new Date().toISOString(),
      agent,
      tool: request.tool ?? request.kind,
      decision: result.decision,
      rule: result.rule,
      detail: String(detail).slice(0, 300),
      ...(watched ? { watched: true } : {}),
    };
    fsx.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // logging must never change the decision
  }
}

// ───────────────────────────── checkpoints ─────────────────────────────
// Before an agent's file write goes through, the old content of the file is copied to
// .agent-guardrails/checkpoints/<id>/files/<path> with a manifest, so `agent-guardrails-kit restore` can put it back.
// Taking a checkpoint never changes the guard's answer: any failure is swallowed. Nothing is ever deleted or rotated;
// when a limit is reached the guard simply stops saving more.

export const CHECKPOINT_DIR = `${STATE_DIR}/checkpoints`;
export const CHECKPOINT_LIMITS = Object.freeze({ maxFileBytes: 1024 * 1024, maxCount: 1000, maxTotalBytes: 200 * 1024 * 1024 });
/** Folders whose files are never copied: they are rebuilt, or they are not the project's own work. */
const CHECKPOINT_SKIP = /(^|\/)(node_modules|\.git|dist|build|\.agent-guardrails)(\/|$)/;

/** The project files a write or patch is about to change, as { rel, real } (inside the project only). */
function checkpointTargets(request, ctx) {
  const base = request.cwd ?? ctx.cwd;
  const raw = [];
  if (request.kind === "write") raw.push(...request.paths);
  else if (request.kind === "patch") {
    for (const line of request.patch.split("\n")) {
      const m = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/.exec(line.trim());
      if (m) raw.push(m[1].trim());
    }
  }
  const seen = new Set();
  const out = [];
  for (const target of raw) {
    const info = pathInfo(target, base, ctx);
    if (!info.inside || info.rel === null || info.rel === "" || seen.has(info.real)) continue;
    seen.add(info.real);
    out.push({ rel: info.rel, real: info.real });
  }
  return out;
}

function takeCheckpoint(request, ctx, agent, now) {
  try {
    const fsx = ctx.fs;
    const targets = checkpointTargets(request, ctx);
    if (targets.length === 0) return;

    const store = path.join(ctx.rootReal, CHECKPOINT_DIR);
    const indexFile = path.join(store, "index.log");
    let count = 0;
    let total = 0;
    try {
      for (const line of fsx.readFileSync(indexFile, "utf8").split("\n")) {
        if (line === "") continue;
        try {
          total += Number(JSON.parse(line).bytes) || 0;
        } catch {
          // a torn line still counts as one checkpoint
        }
        count += 1;
      }
    } catch {
      // no index yet
    }
    if (count >= CHECKPOINT_LIMITS.maxCount || total >= CHECKPOINT_LIMITS.maxTotalBytes) return;

    const files = [];
    const copies = [];
    let bytes = 0;
    for (const target of targets) {
      const entry = { path: target.rel, existed: false, bytes: 0 };
      files.push(entry);
      if (CHECKPOINT_SKIP.test(target.rel) || isSecretFile(target.rel)) {
        entry.skipped = "ignored-folder";
        continue;
      }
      try {
        if (fsx.lstatSync(target.real).isDirectory()) {
          entry.existed = true;
          entry.skipped = "not-a-file";
          continue;
        }
      } catch {
        continue; // the file does not exist yet: recorded as "did not exist"
      }
      entry.existed = true;
      let size;
      try {
        size = fsx.statSync(target.real).size;
      } catch {
        size = undefined;
      }
      if (size !== undefined && size > CHECKPOINT_LIMITS.maxFileBytes) {
        entry.bytes = size;
        entry.skipped = "too-big";
        continue;
      }
      let text;
      try {
        text = fsx.readFileSync(target.real, "utf8");
      } catch {
        entry.skipped = "unreadable";
        continue;
      }
      const length = Buffer.byteLength(text, "utf8");
      entry.bytes = length;
      if (length > CHECKPOINT_LIMITS.maxFileBytes) {
        entry.skipped = "too-big";
      } else if (text.includes(String.fromCharCode(0)) || text.includes(String.fromCharCode(0xfffd)) || (size !== undefined && size !== length)) {
        // Binary, or text that would not copy back byte for byte.
        entry.skipped = "not-text";
      } else {
        copies.push({ rel: target.rel, text });
        bytes += length;
      }
    }
    if (total + bytes > CHECKPOINT_LIMITS.maxTotalBytes) return;

    const id = `${now.toISOString().replace(/[-:.]/g, "")}-${crypto.randomBytes(2).toString("hex")}`;
    const dir = path.join(store, id);
    for (const copy of copies) {
      const dest = path.join(dir, "files", ...copy.rel.split("/"));
      fsx.mkdirSync(path.dirname(dest), { recursive: true });
      fsx.writeFileSync(dest, copy.text, "utf8");
    }
    fsx.mkdirSync(dir, { recursive: true });
    const manifest = { version: 1, id, ts: now.toISOString(), agent, tool: request.tool ?? request.kind, files };
    fsx.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fsx.appendFileSync(indexFile, `${JSON.stringify({ id, bytes })}\n`, "utf8");
  } catch {
    // a checkpoint must never change the decision
  }
}

// ───────────────────────────── cli ─────────────────────────────

function parseArgs(argv) {
  const out = { agent: undefined, root: undefined };
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === "--agent") out.agent = argv[k + 1];
    else if (argv[k] === "--root") out.root = argv[k + 1];
  }
  return out;
}

function inferAgent(payload) {
  if (payload && typeof payload === "object") {
    if (typeof payload.command === "string" && !payload.tool_name) return "cursor";
    if (typeof payload.cursor_version === "string" || Array.isArray(payload.workspace_roots)) return "cursor";
  }
  return "claude";
}

/**
 * Runs the guard for one payload. Pure apart from reading project files and appending to the audit log.
 * Never throws: any failure becomes a deny.
 */
export function runGuard({ stdin, argv = [], scriptDir, fsImpl = fs, home = process.env.HOME ?? process.env.USERPROFILE ?? "/", audit = true, now = new Date() }) {
  const args = parseArgs(argv);
  let agent = AGENTS.includes(args.agent) ? args.agent : undefined;
  try {
    if (typeof stdin !== "string" || stdin.trim() === "") {
      return respond(agent ?? "claude", mk("deny", "empty-input", "The hook received no input."));
    }
    let payload;
    try {
      payload = JSON.parse(stdin);
    } catch {
      return respond(agent ?? "claude", mk("deny", "invalid-input", "The hook input is not valid JSON."));
    }
    agent = agent ?? inferAgent(payload);

    usePathFlavour(fsImpl);
    const root = path.resolve(args.root ?? path.join(scriptDir, ".."));
    const rootReal = realpathSafe(fsImpl, root);

    let config = { ...DEFAULT_CONFIG, allowCommands: [], gitAllow: [...DEFAULT_CONFIG.gitAllow] };
    const configPath = path.join(rootReal, CONFIG_FILE);
    if (fsImpl.existsSync(configPath)) {
      let parsed;
      try {
        parsed = JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
      } catch (error) {
        return respond(agent, mk("deny", "bad-config", `${CONFIG_FILE} is not valid JSON (${error.message}). Fix it, then retry.`));
      }
      const checked = validateConfig(parsed);
      if (checked.error) return respond(agent, mk("deny", "bad-config", `${CONFIG_FILE} is invalid: ${checked.error}.`));
      config = checked.config;
    }

    const ctx = { root, rootReal, cwd: rootReal, home, config, fs: fsImpl };
    const request = normalizeRequest(payload);
    const result = evaluate(request, ctx);
    // Watch mode: an "ask" runs and is logged as what it was (flagged watched). Denies are never softened.
    const watched = result.decision === "ask" && !WATCH_KEEP_ASKING.has(result.rule) && watchActive(config, now);
    if (audit) writeAudit(ctx, agent, request, result, watched);
    // Save the old content of files about to be written. Codex cannot ask, so an ask there is a deny and writes nothing.
    const effective = watched ? "allow" : result.decision === "ask" && agent === "codex" ? "deny" : result.decision;
    if (audit && config.checkpoints && effective !== "deny" && (request.kind === "write" || request.kind === "patch")) {
      takeCheckpoint(request, ctx, agent, now);
    }
    return respond(agent, watched ? mk("allow", "watched", `Watch mode: this would have asked (${result.rule}).`) : result);
  } catch (error) {
    return respond(agent ?? "claude", mk("deny", "guard-error", `The guard crashed and fails closed (${error?.message ?? error}).`));
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const out = runGuard({
    stdin: await readStdin(),
    argv: process.argv.slice(2),
    scriptDir: path.dirname(fileURLToPath(import.meta.url)),
    // Set by `agent-guardrails-kit test --hooks` so the self-test does not fill the audit log. An agent cannot
    // set this: the variable must be in the hook's own environment, not in the command being checked.
    audit: process.env.AGENT_GUARDRAILS_NO_AUDIT !== "1",
  });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}

/**
 * True when this file was started as a script (as opposed to imported by a test or another module).
 * Real paths are compared, because the project folder may be reached through a symlink (macOS temp
 * folders, projects on another volume). If anything goes wrong while checking, answer "yes, run":
 * running and denying is safe, silently doing nothing would allow every action.
 */
function startedAsScript() {
  if (!process.argv[1]) return false;
  // When this code is bundled into another program (the kit's own CLI), that program is the entry point and
  // this file's name is not "guard.mjs". Only the installed copy, which keeps its name, ever runs as a script.
  if (path.basename(fileURLToPath(import.meta.url)) !== "guard.mjs") return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
}

if (startedAsScript()) {
  main().catch((error) => {
    process.stderr.write(`agent-guardrails guard crashed and fails closed: ${error?.message ?? error}\n`);
    process.exitCode = 2;
  });
}
