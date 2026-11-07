import { describe, expect, it } from "vitest";
import { ROOT, shell } from "../../../../tests/helpers/guard-ctx.ts";
import { makeContext } from "../sandbox.ts";

/** A project whose files are given relative to the project folder. */
function project(files: Record<string, string>, config: Record<string, unknown> = {}) {
  const absolute = Object.fromEntries(Object.entries(files).map(([name, text]) => [name.startsWith("/") ? name : `${ROOT}/${name}`, text]));
  return makeContext({ files: absolute, config: config as never });
}

const NUL = String.fromCharCode(0);

describe("script scanning: Python, JavaScript, Ruby and other languages", () => {
  it("blocks a script that deletes files, and says where", () => {
    const ctx = project({ "scripts/clean.py": 'import os\nprint("cleaning")\nos.remove("build/out.txt")\n' });
    const result = shell("python scripts/clean.py", ctx);
    expect(result).toMatchObject({ decision: "deny", rule: "script-scan" });
    expect(result.reason).toContain("scripts/clean.py line 3 deletes files (os.remove)");
  });

  it.each([
    ["python", "scripts/a.py", 'from pathlib import Path\nPath("x").unlink()\n'],
    ["python3", "scripts/a.py", 'import shutil\nshutil.rmtree("build")\n'],
    ["node", "scripts/a.js", 'const fs = require("fs");\nfs.rmSync("dist", { recursive: true });\n'],
    ["node", "scripts/a.mjs", 'import { rm } from "node:fs/promises";\nawait rm("dist");\n'],
    ["bun", "scripts/a.ts", 'import rimraf from "rimraf";\nrimraf.sync("dist");\n'],
    ["ruby", "scripts/a.rb", 'require "fileutils"\nFileUtils.rm_rf("tmp")\n'],
    ["php", "scripts/a.php", '<?php\nunlink("x.txt");\n'],
  ])("blocks %s %s when it deletes files", (program, file, text) => {
    expect(shell(`${program} ${file}`, project({ [file]: text }))).toMatchObject({ decision: "deny", rule: "script-scan" });
  });

  it("blocks destructive SQL in a script", () => {
    for (const text of [
      'cur.execute("DELETE FROM sessions WHERE id = ?")\n',
      'cur.execute("DROP TABLE users")\n',
      'sql = """\nDELETE FROM sessions\nWHERE expired\n"""\n',
      "TRUNCATE TABLE logs;\n",
    ]) {
      expect(shell("python scripts/db.py", project({ "scripts/db.py": text })), text).toMatchObject({ decision: "deny", rule: "script-scan" });
    }
  });

  it("blocks a script that touches the guardrail files", () => {
    const result = shell("python scripts/x.py", project({ "scripts/x.py": 'open(".githooks/pre-commit", "w").write("")\n' }));
    expect(result).toMatchObject({ decision: "deny", rule: "script-scan" });
    expect(result.reason).toContain("touches guardrail files");
  });

  it("does not block everyday code that only looks similar", () => {
    for (const text of [
      'df = df.drop(columns=["a"])\n',
      'shutil.move("a", "b")\n',
      "# truncate the output when it is long\n",
      "# delete from the list when done\n",
      'os.makedirs("out", exist_ok=True)\n',
      'subprocess.run(["ls"])\n',
    ]) {
      const result = shell("python scripts/ok.py", project({ "scripts/ok.py": text }));
      expect(result.rule, text).not.toBe("script-scan");
      expect(result.decision, text).toBe("ask");
    }
  });

  it("looks at every script file named on the command, up to three", () => {
    const files = { "a.js": "console.log(1)\n", "b.js": "console.log(2)\n", "c.js": "console.log(3)\n", "d.js": "console.log(4)\n" };
    expect(shell("node a.js b.js c.js d.js", project({ ...files, "c.js": 'fs.rmSync("x")\n' }))).toMatchObject({ decision: "deny", rule: "script-scan" });
    expect(shell("node a.js b.js c.js d.js", project({ ...files, "d.js": 'fs.rmSync("x")\n' })).rule).not.toBe("script-scan");
  });

  it("also reads a file that is only passed as an option value", () => {
    const ctx = project({ "hook.js": 'fs.rmSync("x")\n', "app.js": "console.log(1)\n" });
    expect(shell("node --require ./hook.js app.js", ctx)).toMatchObject({ decision: "deny", rule: "script-scan" });
  });

  it("follows a package script to the file it runs", () => {
    const ctx = project({
      "package.json": JSON.stringify({ scripts: { clean: "node scripts/clean.js" } }),
      "scripts/clean.js": 'fs.rmSync("dist", { recursive: true });\n',
    });
    const result = shell("npm run clean", ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("scripts/clean.js");
  });
});

describe("script scanning: shell scripts", () => {
  it("blocks a shell script with a command the guard blocks, naming the line", () => {
    const ctx = project({ "scripts/clean.sh": "#!/bin/bash\nset -e\nrm -rf build\n" });
    const result = shell("bash scripts/clean.sh", ctx);
    expect(result).toMatchObject({ decision: "deny", rule: "script-scan" });
    expect(result.reason).toContain("scripts/clean.sh line 3");
    expect(result.reason).toContain("file-deletion");
  });

  it("blocks git changes inside a script", () => {
    expect(shell("sh scripts/push.sh", project({ "scripts/push.sh": "git push origin main\n" }))).toMatchObject({ decision: "deny", rule: "script-scan" });
  });

  it("follows a script that runs another script", () => {
    const ctx = project({ "scripts/a.sh": "echo start\nbash scripts/b.sh\n", "scripts/b.sh": "rm -rf x\n" });
    const result = shell("bash scripts/a.sh", ctx);
    expect(result).toMatchObject({ decision: "deny", rule: "script-scan" });
    expect(result.reason).toContain("scripts/b.sh");
  });

  it("blocks sourcing a script that is bad", () => {
    const ctx = project({ "scripts/clean.sh": "rm -rf build\n" });
    expect(shell("source scripts/clean.sh", ctx)).toMatchObject({ decision: "deny", rule: "script-scan" });
    expect(shell(". scripts/clean.sh", ctx)).toMatchObject({ decision: "deny", rule: "script-scan" });
  });

  it("still asks about a clean script, and says it was scanned", () => {
    const ctx = project({ "scripts/ok.sh": "echo hi\nls\n" });
    const result = shell("bash scripts/ok.sh", ctx);
    expect(result).toMatchObject({ decision: "ask", rule: "script-exec" });
    expect(result.reason).toContain("Scanned scripts/ok.sh");
    expect(result.reason).toContain("not followed");
    expect(shell("source scripts/ok.sh", ctx)).toMatchObject({ decision: "ask", rule: "script-exec" });
  });

  it("does not scan bash -c, which is already analysed as text", () => {
    expect(shell('bash -c "rm -rf x"', project({}))).toMatchObject({ decision: "deny", rule: "file-deletion" });
  });
});

describe("script scanning: files run directly", () => {
  it("scans a file with a #! line", () => {
    const ctx = project({ "scripts/clean.sh": "#!/bin/sh\nrm -rf build\n", "scripts/tidy": "#!/usr/bin/env python3\nimport os\nos.remove('x')\n" });
    expect(shell("./scripts/clean.sh", ctx)).toMatchObject({ decision: "deny", rule: "script-scan" });
    expect(shell("scripts/tidy", ctx)).toMatchObject({ decision: "deny", rule: "script-scan" });
  });

  it("scans a file with a script extension and no #! line", () => {
    expect(shell("./clean.py", project({ "clean.py": "import os\nos.remove('x')\n" }))).toMatchObject({ decision: "deny", rule: "script-scan" });
  });

  it("leaves other files alone", () => {
    const result = shell("./notes.txt", project({ "notes.txt": "rm -rf build\n" }));
    expect(result.rule).not.toBe("script-scan");
  });
});

describe("script scanning: your allow list and the limits", () => {
  it("lets a clean script you allowed run", () => {
    const ctx = project({ "scripts/build.py": 'print("building")\n' }, { allowCommands: ["python scripts/build.py"] });
    expect(shell("python scripts/build.py", ctx)).toMatchObject({ decision: "allow", rule: "user-allowed" });
  });

  it("blocks a bad script even when you allowed the command", () => {
    const ctx = project({ "scripts/build.py": "import os\nos.remove('x')\n" }, { allowCommands: ["python scripts/build.py"] });
    expect(shell("python scripts/build.py", ctx)).toMatchObject({ decision: "deny", rule: "script-scan" });
  });

  it("changes nothing when the file does not exist", () => {
    expect(shell("python scripts/missing.py", project({}))).toMatchObject({ decision: "ask", rule: "unknown-command" });
  });

  it("leaves inline code and modules to the checks they already have", () => {
    expect(shell(`python -c "import os; os.remove('x')"`, project({}))).toMatchObject({ decision: "deny", rule: "file-deletion" });
    expect(shell("python -m pytest", project({ "pytest.py": "import os\nos.remove('x')\n" })).rule).not.toBe("script-scan");
  });

  it("does not read files outside the project", () => {
    const ctx = project({ "/elsewhere/evil.py": "import os\nos.remove('x')\n" });
    expect(shell("python /elsewhere/evil.py", ctx).rule).not.toBe("script-scan");
  });

  it("does not read installed dependencies", () => {
    const ctx = project({ "node_modules/pkg/cli.js": 'fs.rmSync("x")\n', ".venv/bin/tool.py": "import os\nos.remove('x')\n" });
    expect(shell("node node_modules/pkg/cli.js", ctx).rule).not.toBe("script-scan");
    expect(shell("python .venv/bin/tool.py", ctx).rule).not.toBe("script-scan");
  });

  it("does not read binary files or very large ones", () => {
    const binary = project({ "scripts/bin.py": `os.remove('x')${NUL}` });
    expect(shell("python scripts/bin.py", binary).rule).not.toBe("script-scan");
    const huge = project({ "scripts/huge.py": `${"x".repeat(300_000)}\nos.remove('x')\n` });
    expect(shell("python scripts/huge.py", huge).rule).not.toBe("script-scan");
  });

  it("does not guess at a file name that is built at run time", () => {
    expect(shell("python $SCRIPT", project({})).rule).not.toBe("script-scan");
  });
});
