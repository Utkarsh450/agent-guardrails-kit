#!/usr/bin/env node
// agent-guardrails:generated installed copy of the git checks. Update it with `agent-guardrails update`; do not edit by hand.
//
// Checks that run from git hooks and from CI, whichever AI agent (or human) made the change:
//   pre-commit          secrets and secret files in staged changes; new dependencies; dangerous install scripts
//   pre-push            force pushes, deleted default/release branches and tags, secrets in commits about to be pushed
//   scan-range <range>  the same scans over a revision range, for CI (for example origin/main...HEAD)
//
// Dependency-free on purpose: it is copied into the project and must run anywhere Node and git do.
// It never prints a secret's value, only where it was found. Exit code 1 blocks; warnings never block.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOW_MARKER = "agent-guardrails:allow-secret";

// ───────────────────────────── secret patterns ─────────────────────────────

/** Known credential formats. Matches are reported by name and place, never by value. */
export const SECRET_PATTERNS = [
  { id: "aws-access-key", name: "AWS access key ID", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/ },
  { id: "github-token", name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "github-fine-grained", name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { id: "private-key", name: "private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "slack-token", name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "stripe-live-key", name: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { id: "google-api-key", name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "npm-token", name: "npm access token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "anthropic-key", name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai-key", name: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/ },
  { id: "jwt", name: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

const PLACEHOLDER = /(example|sample|your[-_ ]|changeme|placeholder|dummy|fake|xxxx|<[^>]*>|\$\{|\{\{|process\.env|os\.environ|\*{4,})/i;

/** Shannon entropy in bits per character; real secrets are random, placeholders are not. */
export function entropy(text) {
  if (text.length === 0) return 0;
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const ASSIGNMENT = /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']([A-Za-z0-9+/=_.\-]{16,})["']/i;
const DB_URL = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?):\/\/([^\s:@/]+):([^\s@/]{4,})@[^\s/]+/i;

/** Returns [{ id, name }] for every kind of secret found on one line. */
export function scanLine(line) {
  if (line.includes(ALLOW_MARKER)) return [];
  const found = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(line)) found.push({ id: pattern.id, name: pattern.name });
  }
  const assignment = ASSIGNMENT.exec(line);
  if (assignment && !PLACEHOLDER.test(assignment[1]) && entropy(assignment[1]) >= 3.2) {
    found.push({ id: "hardcoded-secret", name: "hard-coded secret value" });
  }
  const url = DB_URL.exec(line);
  if (url && !PLACEHOLDER.test(url[2]) && !/^(password|pass|secret|pwd|user|username|root|admin|postgres|redis)$/i.test(url[2])) {
    found.push({ id: "database-url-password", name: "password inside a database URL" });
  }
  return found;
}

/** Scans text (a whole file) and returns [{ line, id, name }]. */
export function scanText(text) {
  const findings = [];
  const lines = text.split("\n");
  for (let k = 0; k < lines.length && k < 50000; k += 1) {
    for (const hit of scanLine(lines[k] ?? "")) findings.push({ line: k + 1, ...hit });
  }
  return findings;
}

// ───────────────────────────── secret files ─────────────────────────────

/** Same rule as the guard's isSecretFile (a test keeps the two identical). */
export function isSecretPath(rel) {
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

const SKIP_SCAN = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$/;
export const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"];

// ───────────────────────────── git helpers ─────────────────────────────

/** Runs git without a shell. Returns { code, stdout, stderr }. */
export function makeGit(cwd) {
  return (args, input) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

/** Parses `git diff -U0` output into the added lines of each file: [{ path, lines: [{ n, text }] }]. */
export function parseAddedLines(diff) {
  const files = [];
  let current = null;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4);
      current = target === "/dev/null" ? null : { path: target.replace(/^b\//, ""), lines: [] };
      if (current) files.push(current);
    } else if (raw.startsWith("@@")) {
      const m = /\+(\d+)/.exec(raw);
      line = m ? Number(m[1]) : 0;
    } else if (current && raw.startsWith("+") && !raw.startsWith("+++")) {
      current.lines.push({ n: line, text: raw.slice(1) });
      line += 1;
    }
  }
  return files;
}

/** Finds secrets in the added lines of a diff and secret-looking file names. */
export function scanAdded(files, changedPaths) {
  const findings = [];
  for (const file of files) {
    if (SKIP_SCAN.test(file.path)) continue;
    for (const entry of file.lines) {
      for (const hit of scanLine(entry.text)) findings.push({ path: file.path, line: entry.n, ...hit });
    }
  }
  const secretFiles = changedPaths.filter((p) => isSecretPath(p));
  return { findings, secretFiles };
}

// ───────────────────────────── dependencies ─────────────────────────────

export const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepack", "postpack"];

const DANGEROUS_SCRIPT = /(\brm\s+-|\brimraf\b|\bcurl\b|\bwget\b|\|\s*(?:ba|z)?sh\b|\beval\b|\bbase64\b|\bnc\s|\bpowershell\b)/i;

/** Names of widely used npm packages; a new dependency whose name is one typo away from one is worth a second look. */
export const POPULAR_PACKAGES = [
  "react", "react-dom", "react-router", "react-router-dom", "react-redux", "redux", "next", "vue", "vue-router", "vuex",
  "pinia", "svelte", "angular", "express", "koa", "fastify", "hapi", "nestjs", "lodash", "underscore", "ramda", "moment",
  "dayjs", "date-fns", "luxon", "axios", "node-fetch", "got", "superagent", "request", "typescript", "ts-node", "tsx",
  "webpack", "webpack-cli", "rollup", "vite", "esbuild", "parcel", "babel-core", "babel-loader", "eslint", "prettier",
  "jest", "mocha", "chai", "sinon", "vitest", "cypress", "playwright", "puppeteer", "supertest", "chalk", "commander",
  "yargs", "inquirer", "minimist", "debug", "dotenv", "uuid", "nanoid", "zod", "yup", "joi", "ajv", "bcrypt", "bcryptjs",
  "jsonwebtoken", "passport", "cors", "helmet", "morgan", "body-parser", "cookie-parser", "express-session", "multer",
  "socket.io", "ws", "mongoose", "mongodb", "mysql", "mysql2", "pg", "sqlite3", "redis", "ioredis", "sequelize",
  "typeorm", "prisma", "knex", "graphql", "apollo-server", "tailwindcss", "postcss", "autoprefixer", "sass", "less",
  "styled-components", "emotion", "classnames", "clsx", "immer", "rxjs", "bluebird", "async", "glob", "rimraf",
  "mkdirp", "fs-extra", "chokidar", "nodemon", "pm2", "cross-env", "concurrently", "husky", "lint-staged", "semver",
  "yaml", "js-yaml", "xml2js", "cheerio", "jsdom", "sharp", "jimp", "multer", "nodemailer", "winston", "pino", "bunyan",
  "colors", "ora", "boxen", "figlet", "open", "execa", "shelljs", "cross-spawn", "tar", "archiver", "adm-zip", "jszip",
  "formik", "swr", "tanstack", "recharts", "d3", "three", "chart.js", "leaflet", "mapbox-gl", "firebase", "aws-sdk",
  "stripe", "twilio", "sendgrid", "openai", "anthropic", "langchain", "electron", "cordova", "ionic", "expo",
  "react-native", "storybook", "gatsby", "nuxt", "remix", "astro", "turbo", "nx", "lerna", "pnpm", "yarn", "npm",
  "core-js", "regenerator-runtime", "tslib", "ts-loader", "eslint-config-prettier", "eslint-plugin-react",
  "body-parser", "compression", "serve-static", "http-proxy", "http-proxy-middleware", "node-sass", "sass-loader",
  "css-loader", "style-loader", "file-loader", "html-webpack-plugin", "mini-css-extract-plugin", "terser",
  "uglify-js", "source-map", "source-map-support", "event-stream", "left-pad", "is-odd", "is-even", "isarray",
  "string-width", "strip-ansi", "ansi-styles", "supports-color", "has-flag", "escape-string-regexp", "minimatch",
  "micromatch", "picomatch", "braces", "fast-glob", "globby", "ignore", "dotenv-expand", "cosmiconfig", "ms",
  "inherits", "safe-buffer", "readable-stream", "through2", "pump", "once", "wrappy", "graceful-fs", "iconv-lite",
  "qs", "querystring", "url-parse", "mime", "mime-types", "form-data", "cookie", "ejs", "pug", "handlebars",
  "mustache", "marked", "markdown-it", "highlight.js", "prismjs", "lodash-es", "react-query", "react-hook-form",
  "react-select", "react-icons", "react-scripts", "react-test-renderer", "react-is", "prop-types", "scheduler",
  "framer-motion", "gsap", "animejs", "jquery", "bootstrap", "popper.js", "normalize.css", "modernizr",
];

/** Real packages that sit one edit away from a popular name. Not worth a warning. */
const KNOWN_NEIGHBOURS = new Set(["preact", "reactn", "koa2", "mongo", "mysql1", "chalk2", "debug2"]);

/** Edit distance with swaps counted as one edit (a common typo). */
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** If `name` looks like a misspelling of a popular package, returns that package's name; otherwise null. */
export function typosquatSuspect(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith("@") || POPULAR_PACKAGES.includes(lower) || KNOWN_NEIGHBOURS.has(lower)) return null;
  const squash = (text) => text.replace(/[-_.]/g, "");
  for (const popular of POPULAR_PACKAGES) {
    if (popular.length < 4) continue;
    if (squash(lower) === squash(popular)) return popular;
    if (lower.length >= 5 && Math.abs(lower.length - popular.length) <= 1 && editDistance(lower, popular) === 1) return popular;
  }
  return null;
}

/** Flags dependency versions that do not come from the registry (git, URLs, local paths). */
export function unusualSpec(spec) {
  return typeof spec === "string" && /^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|link:|portal:|[\w.-]+\/[\w.-]+(?:#.*)?$)/i.test(spec);
}

function dependencyMap(pkg) {
  const map = new Map();
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = pkg && typeof pkg[section] === "object" && pkg[section] !== null ? pkg[section] : {};
    for (const [name, spec] of Object.entries(entries)) map.set(name, { section, spec: String(spec) });
  }
  return map;
}

/** What a package.json change adds: new dependencies and new or changed install scripts. */
export function diffDependencies(before, after) {
  const old = dependencyMap(before);
  const added = [];
  const changedSpecs = [];
  for (const [name, entry] of dependencyMap(after)) {
    const prior = old.get(name);
    if (!prior) added.push({ name, ...entry });
    else if (prior.spec !== entry.spec && unusualSpec(entry.spec)) changedSpecs.push({ name, ...entry });
  }
  const scripts = [];
  const beforeScripts = before && typeof before.scripts === "object" && before.scripts !== null ? before.scripts : {};
  const afterScripts = after && typeof after.scripts === "object" && after.scripts !== null ? after.scripts : {};
  for (const name of INSTALL_SCRIPTS) {
    if (typeof afterScripts[name] === "string" && afterScripts[name] !== beforeScripts[name]) {
      scripts.push({ name, body: afterScripts[name], dangerous: DANGEROUS_SCRIPT.test(afterScripts[name]) });
    }
  }
  return { added, changedSpecs, scripts };
}

function readJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Turns a dependency diff for one package.json into errors and warnings. */
export function dependencyFindings(file, diff) {
  const errors = [];
  const warnings = [];
  if (diff.added.length > 0) {
    warnings.push(`${file}: new dependencies: ${diff.added.map((d) => `${d.name}@${d.spec}`).join(", ")}. Check each exists, is spelled right and is something you trust.`);
  }
  for (const dep of diff.added) {
    const similar = typosquatSuspect(dep.name);
    if (similar) warnings.push(`${file}: "${dep.name}" looks like a misspelling of "${similar}". AI tools sometimes invent package names, and attackers register look-alikes.`);
  }
  for (const dep of [...diff.added, ...diff.changedSpecs]) {
    if (unusualSpec(dep.spec)) warnings.push(`${file}: "${dep.name}" installs from outside the registry (${dep.spec}).`);
  }
  for (const script of diff.scripts) {
    if (script.dangerous) errors.push(`${file}: the "${script.name}" script runs code that deletes files or downloads and runs programs: ${script.body}`);
    else warnings.push(`${file}: new or changed "${script.name}" script runs on every install: ${script.body}`);
  }
  return { errors, warnings };
}

// ───────────────────────────── the checks ─────────────────────────────

function splitNul(text) {
  return text.split("\0").filter((entry) => entry !== "");
}

function dependencyChecks(git, changed, oldRef, newRef) {
  const errors = [];
  const warnings = [];
  const packageFiles = changed.filter((p) => path.posix.basename(p) === "package.json");
  for (const file of packageFiles) {
    const after = git(["show", `${newRef}:${file}`]);
    if (after.code !== 0) continue; // deleted
    const afterJson = readJson(after.stdout);
    if (afterJson === null) {
      warnings.push(`${file}: is not valid JSON.`);
      continue;
    }
    const before = git(["show", `${oldRef}:${file}`]);
    const beforeJson = before.code === 0 ? readJson(before.stdout) : {};
    const found = dependencyFindings(file, diffDependencies(beforeJson ?? {}, afterJson));
    errors.push(...found.errors);
    warnings.push(...found.warnings);
  }
  const lockChanged = changed.filter((p) => LOCKFILES.includes(path.posix.basename(p)));
  if (lockChanged.length > 0 && packageFiles.length === 0) {
    warnings.push(`${lockChanged.join(", ")} changed but no package.json did. Check where the dependency change came from.`);
  }
  return { errors, warnings };
}

function formatScan(scan) {
  const errors = [];
  for (const file of scan.secretFiles) errors.push(`${file}: is a secret or credentials file and must not be committed.`);
  for (const f of scan.findings) errors.push(`${f.path}:${f.line}: looks like a ${f.name}.`);
  return errors;
}

/** Checks the staged changes. `git` is makeGit(cwd) or a test double. */
export function runPreCommit(git) {
  const names = splitNul(git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).stdout);
  const diff = git(["diff", "--cached", "-U0", "--no-color", "--diff-filter=ACMR"]).stdout;
  const errors = formatScan(scanAdded(parseAddedLines(diff), names));
  const deps = dependencyChecks(git, names, "HEAD", "");
  return { errors: [...errors, ...deps.errors], warnings: deps.warnings };
}

const ZERO = /^0+$/;

const PROTECTED_BRANCH = /^(main|master|develop|development|trunk|release([/-].*)?|hotfix([/-].*)?)$/;

/**
 * Why a remote ref must not be deleted from here, or "" when deleting it is fine. Ordinary feature branches may be
 * deleted (for example after a pull request is merged). Tags, the default branch, release branches and any ref
 * that is not a branch are protected. When unsure, protected.
 */
function protectedRefReason(git, remoteRef) {
  if (remoteRef.startsWith("refs/tags/")) return "Deleting tags is not allowed from a hook-protected clone.";
  if (!remoteRef.startsWith("refs/heads/")) return "Deleting this kind of ref is not allowed from a hook-protected clone.";
  const name = remoteRef.slice("refs/heads/".length);
  if (PROTECTED_BRANCH.test(name)) return "Deleting the main or a release branch is not allowed from a hook-protected clone.";
  const head = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim() === `origin/${name}`) return "Deleting the default branch is not allowed from a hook-protected clone.";
  return "";
}

/** Checks what is about to be pushed. `stdin` is git's "<local ref> <local sha> <remote ref> <remote sha>" lines. */
export function runPrePush(git, stdin) {
  const errors = [];
  const warnings = [];
  for (const rawLine of stdin.split("\n")) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts;

    if (ZERO.test(localSha)) {
      const reason = protectedRefReason(git, remoteRef);
      if (reason) errors.push(`${remoteRef}: pushing here would delete it on the remote. ${reason}`);
      continue;
    }

    let range;
    if (ZERO.test(remoteSha)) {
      const commits = git(["rev-list", localSha, "--not", "--remotes"]).stdout.split("\n").filter(Boolean);
      range = { commits };
    } else {
      const known = git(["cat-file", "-e", `${remoteSha}^{commit}`]).code === 0;
      const ancestor = known && git(["merge-base", "--is-ancestor", remoteSha, localSha]).code === 0;
      if (!ancestor) {
        errors.push(`${localRef} -> ${remoteRef}: not a fast-forward (this would rewrite history on the remote, for example a force push).`);
        continue;
      }
      range = { commits: git(["rev-list", `${remoteSha}..${localSha}`]).stdout.split("\n").filter(Boolean) };
    }

    for (const commit of range.commits.slice(0, 200)) {
      const names = splitNul(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--diff-filter=ACMR", "-z", commit]).stdout);
      const diff = git(["show", "--format=", "-U0", "--no-color", "--diff-filter=ACMR", commit]).stdout;
      const scan = scanAdded(parseAddedLines(diff), names);
      for (const message of formatScan(scan)) errors.push(`commit ${commit.slice(0, 8)}: ${message}`);
    }
    if (range.commits.length > 200) warnings.push(`${localRef}: only the newest 200 commits were scanned for secrets.`);
  }
  return { errors, warnings };
}

/** Scans a revision range such as origin/main...HEAD. Used by CI. */
export function runScanRange(git, range) {
  const diff = git(["diff", "--no-color", "-U0", "--diff-filter=ACMR", range]);
  if (diff.code !== 0) return { errors: [`could not diff ${range}: ${diff.stderr.trim()}`], warnings: [] };
  const names = splitNul(git(["diff", "--name-only", "--diff-filter=ACMR", "-z", range]).stdout);
  const errors = formatScan(scanAdded(parseAddedLines(diff.stdout), names));

  const [base, head] = range.includes("...") ? range.split("...") : range.split("..");
  const mergeBase = git(["merge-base", base || "HEAD", head || "HEAD"]);
  const deps = dependencyChecks(git, names, mergeBase.code === 0 ? mergeBase.stdout.trim() : base, head || "HEAD");
  return { errors: [...errors, ...deps.errors], warnings: deps.warnings };
}

// ───────────────────────────── command line ─────────────────────────────

const HINT =
  `If a finding is a false alarm, put "${ALLOW_MARKER}" on that line. Only a person should bypass a hook (git --no-verify); an AI agent must ask first.`;

export function report(title, result) {
  const lines = [];
  for (const warning of result.warnings) lines.push(`agent-guardrails: warning: ${warning}`);
  if (result.errors.length > 0) {
    lines.push(`agent-guardrails: ${title} BLOCKED`);
    for (const error of result.errors) lines.push(`  - ${error}`);
    lines.push(`  ${HINT}`);
  }
  return lines.join("\n");
}

function main(argv) {
  const [command, ...rest] = argv;
  const git = makeGit(process.cwd());
  let result;
  let title;
  if (command === "pre-commit") {
    title = "commit";
    result = runPreCommit(git);
  } else if (command === "pre-push") {
    title = "push";
    result = runPrePush(git, fs.readFileSync(0, "utf8"));
  } else if (command === "scan-range" && rest[0]) {
    title = "scan";
    result = runScanRange(git, rest[0]);
  } else {
    process.stderr.write("usage: git-checks.mjs pre-commit | pre-push | scan-range <revision-range>\n");
    return 2;
  }
  const text = report(title, result);
  if (text) process.stderr.write(`${text}\n`);
  return result.errors.length > 0 ? 1 : 0;
}

function startedAsScript() {
  if (!process.argv[1]) return false;
  // When this code is bundled into another program (the kit's own CLI), that program is the entry point and
  // this file's name is not "git-checks.mjs". Only the installed copy, which keeps its name, ever runs as a script.
  if (path.basename(fileURLToPath(import.meta.url)) !== "git-checks.mjs") return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true; // when unsure, run: a hook that does nothing would let everything through
  }
}

if (startedAsScript()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`agent-guardrails: the check crashed, so it blocks to be safe (${error?.message ?? error})\n`);
    process.exitCode = 1;
  }
}
