import { describe, expect, it } from "vitest";
import { fakeFs } from "../sandbox.ts";
import { DEFAULT_CONFIG, evaluate, normalizeRequest, type GuardContext, type GuardFs } from "./guard.mjs";

/**
 * The guard with Windows paths. The other guard tests use a POSIX fake file system on every machine; these use
 * C:\proj, so the Windows rules (drive letters, case, Git Bash paths like /c/proj) are checked on any machine.
 */

const ROOT = "C:\\proj";

function windowsContext(): GuardContext {
  const folders = new Set(["c:\\", "c:\\proj", "c:\\proj\\src"]);
  const fsx: GuardFs = {
    ...fakeFs(),
    pathFlavour: "win32",
    // Like a real Windows disk: C:\etc and C:\usr do not exist.
    existsSync: (p) => folders.has(p.toLowerCase()),
    realpathSync: (p) => p,
  };
  return {
    root: ROOT,
    rootReal: ROOT,
    cwd: ROOT,
    home: "C:\\Users\\tester",
    config: { ...DEFAULT_CONFIG, allowCommands: [], gitAllow: [...DEFAULT_CONFIG.gitAllow] },
    fs: fsx,
  };
}

const run = (command: string, tool = "Bash") => evaluate(normalizeRequest({ tool_name: tool, tool_input: { command }, cwd: ROOT }), windowsContext());

describe("the guard with Windows paths", () => {
  it.each([
    "cat /etc/passwd",
    "ls /etc",
    "grep -r foo /usr",
    "cat src/a.ts /etc/passwd",
    "cat /c/Windows/win.ini",
    "cat C:/Windows/win.ini",
    "cat ../other.txt",
    "echo x > /tmp/x.txt",
    "cat ~/.ssh/id_rsa",
  ])("blocks %s", (command) => {
    expect(run(command)).toMatchObject({ decision: "deny" });
  });

  it("names the outside-project rule for Linux-style absolute paths", () => {
    expect(run("cat /etc/passwd")).toMatchObject({ decision: "deny", rule: "outside-project" });
  });

  it.each(["cat src/a.ts", "cat /c/proj/src/a.ts", "cat c:/PROJ/src/a.ts", "ls", "git status"])("allows %s inside the project, whatever the letter case", (command) => {
    expect(run(command)).toMatchObject({ decision: "allow" });
  });

  it("still treats a search pattern as a pattern", () => {
    expect(run("grep -n /todo/ src/a.ts")).toMatchObject({ decision: "allow" });
  });

  it("finds secret files whatever the letter case", () => {
    expect(run("cat .ENV")).toMatchObject({ decision: "deny", rule: "secret-file" });
  });

  it.each(["Get-Content src\\a.ts", "Get-ChildItem C:\\proj\\src", "Select-String -Pattern todo -Path src\\a.ts", "Get-Location"])("lets the PowerShell tool run %s inside the project", (command) => {
    expect(run(command, "PowerShell")).toMatchObject({ decision: "allow" });
  });

  it.each(["Get-Content ..\\..\\other.txt", "Get-ChildItem C:\\Windows", "Get-Content .env", "Get-Content C:\\Users\\tester\\.ssh\\id_rsa"])("blocks PowerShell %s", (command) => {
    expect(run(command, "PowerShell")).toMatchObject({ decision: "deny" });
  });

  it("still asks about PowerShell commands it does not know", () => {
    expect(run("Invoke-WebRequest https://example.com", "PowerShell")).toMatchObject({ decision: "ask" });
  });

  it.each(["PowerShell", "pwsh"])("checks the %s tool like a shell, including its delete commands", (tool) => {
    expect(run("Remove-Item -Recurse -Force src", tool)).toMatchObject({ decision: "deny", rule: "file-deletion" });
    expect(run("git push origin HEAD", tool)).toMatchObject({ decision: "deny" });
  });
});