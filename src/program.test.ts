import { describe, expect, it } from "vitest";
import { ScriptedUi } from "../tests/helpers/scripted-ui.ts";
import { buildProgram, reportError } from "./program.ts";
import { CancelledError, CliError } from "./features/commands/errors.ts";

describe("buildProgram", () => {
  it("has the expected name and a version", () => {
    const program = buildProgram();
    expect(program.name()).toBe("agent-guardrails");
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("registers every command", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(["init", "update", "doctor", "sync", "approve", "report", "alerts", "allow", "preset", "mode", "checkpoints", "restore", "explain", "test", "ui"]);
    const allow = buildProgram().commands.find((c) => c.name() === "allow");
    expect(allow?.commands.map((c) => c.name())).toEqual(["list", "add", "remove"]);
  });

  it("describes every command in plain words", () => {
    for (const command of buildProgram().commands) expect(command.description().length, command.name()).toBeGreaterThan(15);
  });

  it("puts the package name and version at the top of the help, and registers both command names", async () => {
    const pkg = (await import("../package.json", { with: { type: "json" } })).default;
    const program = buildProgram();
    let help = "";
    program.configureOutput({ writeOut: (text) => (help += text), writeErr: (text) => (help += text) });
    program.exitOverride();
    try {
      await program.parseAsync(["--help"], { from: "user" });
    } catch {
      // commander exits after printing help
    }
    expect(help.startsWith(`${pkg.name} v${pkg.version}\n`)).toBe(true);
    expect(Object.keys(pkg.bin).sort()).toEqual(["agent-guardrails", "agent-guardrails-kit"]);
    expect(new Set(Object.values(pkg.bin)).size).toBe(1);
  });

  it("shows a quick start in the help", () => {
    const help = buildProgram().helpInformation() + "\n";
    expect(help).toContain("Set up safe, shared rules");
    expect(help).toContain("--cwd");
  });
});

describe("reportError", () => {
  it("prints friendly messages and picks the exit code", () => {
    const ui = new ScriptedUi();
    expect(reportError(ui, new CliError("Say which agents."))).toBe(1);
    expect(reportError(ui, new CliError("custom", 3))).toBe(3);
    expect(reportError(ui, new CancelledError())).toBe(130);
    expect(reportError(ui, new Error("boom"))).toBe(1);
    expect(reportError(ui, "text")).toBe(1);
    expect(ui.text).toContain("ERROR: Say which agents.");
    expect(ui.text).toContain("WARN: Cancelled. Nothing was changed.");
    expect(ui.text).toContain("ERROR: Something went wrong: boom");
    expect(ui.text).not.toContain("at ");
  });
});
