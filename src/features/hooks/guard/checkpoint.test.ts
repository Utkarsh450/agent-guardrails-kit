import { describe, expect, it } from "vitest";
import { ROOT } from "../../../../tests/helpers/guard-ctx.ts";
import { fakeFs, type FakeFs } from "../sandbox.ts";
import { CHECKPOINT_DIR, CHECKPOINT_LIMITS, hashPlan, runGuard } from "./guard.mjs";

const NOW = new Date("2026-11-07T10:30:00.000Z");
const PLAN = "# Plan\n- do the thing\n";
const STORE = `${ROOT}/${CHECKPOINT_DIR}`;
const ID = /^20261107T103000000Z-[0-9a-f]{4}$/;

interface Options {
  files?: Record<string, string>;
  config?: Record<string, unknown>;
  agent?: string;
  approved?: boolean;
  audit?: boolean;
  tweak?: (fsImpl: FakeFs) => void;
}

function run(payload: object, options: Options = {}) {
  const { files = {}, config = {}, agent = "claude", approved = true, audit = true, tweak } = options;
  const project: Record<string, string> = { [`${ROOT}/agent-guardrails.config.json`]: JSON.stringify({ version: 1, ...config }) };
  if (approved) {
    project[`${ROOT}/PLAN.md`] = PLAN;
    project[`${ROOT}/.agent-guardrails/approval.json`] = JSON.stringify({ version: 1, plan: "PLAN.md", sha256: hashPlan(PLAN) });
  }
  for (const [name, text] of Object.entries(files)) project[`${ROOT}/${name}`] = text;
  const fsImpl = fakeFs(project);
  tweak?.(fsImpl);
  const out = runGuard({ stdin: JSON.stringify({ cwd: ROOT, ...payload }), argv: ["--agent", agent], scriptDir: `${ROOT}/.agent-guardrails`, fsImpl, home: "/home/tester", now: NOW, audit });
  return { out, fsImpl };
}

const write = (file: string, content = "new") => ({ tool_name: "Write", tool_input: { file_path: `${ROOT}/${file}`, content } });
const saved = (fsImpl: FakeFs) => [...fsImpl.files.keys()].filter((key) => key.startsWith(`${STORE}/`) && !key.endsWith("/index.log"));
const manifestOf = (fsImpl: FakeFs) => {
  const key = saved(fsImpl).find((k) => k.endsWith("/manifest.json"));
  return key === undefined ? null : (JSON.parse(fsImpl.files.get(key) ?? "null") as { id: string; ts: string; agent: string; tool: string; files: Array<Record<string, unknown>> });
};

describe("checkpoints in the guard", () => {
  it("saves the old content of a file before a write", () => {
    const { out, fsImpl } = run(write("src/a.ts"), { files: { "src/a.ts": "old content" } });
    expect(out.exitCode).toBe(0);

    const manifest = manifestOf(fsImpl);
    expect(manifest).toMatchObject({ agent: "claude", tool: "Write", ts: NOW.toISOString(), files: [{ path: "src/a.ts", existed: true, bytes: 11 }] });
    expect(manifest?.id).toMatch(ID);
    expect(fsImpl.files.get(`${STORE}/${manifest?.id}/files/src/a.ts`)).toBe("old content");
    expect(fsImpl.files.get(`${STORE}/index.log`)).toBe(`${JSON.stringify({ id: manifest?.id, bytes: 11 })}\n`);
  });

  it("records a file that does not exist yet, without a copy", () => {
    const { fsImpl } = run(write("src/new.ts"));
    expect(manifestOf(fsImpl)?.files).toEqual([{ path: "src/new.ts", existed: false, bytes: 0 }]);
    expect(saved(fsImpl).filter((key) => key.includes("/files/"))).toEqual([]);
  });

  it("works for Edit and MultiEdit", () => {
    for (const tool of ["Edit", "MultiEdit"]) {
      const payload = { tool_name: tool, tool_input: { file_path: `${ROOT}/src/a.ts`, old_string: "a", new_string: "b" } };
      const { fsImpl } = run(payload, { files: { "src/a.ts": "keep me" } });
      expect(manifestOf(fsImpl), tool).toMatchObject({ tool, files: [{ path: "src/a.ts", existed: true }] });
    }
  });

  it("saves every file of a Codex patch once", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+hi\n*** End Patch";
    const { out, fsImpl } = run({ tool_name: "apply_patch", tool_input: { command: patch } }, { agent: "codex", files: { "src/a.ts": "old" } });
    expect(out.exitCode).toBe(0);
    expect(manifestOf(fsImpl)).toMatchObject({
      agent: "codex",
      tool: "apply_patch",
      files: [
        { path: "src/a.ts", existed: true },
        { path: "src/b.ts", existed: false },
      ],
    });
  });

  it("saves nothing when the write is blocked", () => {
    const { out, fsImpl } = run(write("src/a.ts"), { files: { "src/a.ts": "old" }, approved: false });
    expect(out.exitCode).toBe(2);
    expect(saved(fsImpl)).toEqual([]);
  });

  it("saves when the write will be asked about, but not for Codex, which cannot ask", () => {
    const ask = run(write("AGENTS.md"), { files: { "AGENTS.md": "rules" } });
    expect(ask.out.stdout).toContain('"permissionDecision":"ask"');
    expect(manifestOf(ask.fsImpl)).toMatchObject({ files: [{ path: "AGENTS.md", existed: true }] });

    const codex = run(write("AGENTS.md"), { files: { "AGENTS.md": "rules" }, agent: "codex" });
    expect(codex.out.exitCode).toBe(2);
    expect(saved(codex.fsImpl)).toEqual([]);
  });

  it("lists but does not copy files in ignored folders", () => {
    const { fsImpl } = run(write("node_modules/pkg/index.js"), { files: { "node_modules/pkg/index.js": "old" } });
    expect(manifestOf(fsImpl)?.files).toEqual([{ path: "node_modules/pkg/index.js", existed: false, bytes: 0, skipped: "ignored-folder" }]);
    expect(saved(fsImpl).filter((key) => key.includes("/files/"))).toEqual([]);
  });

  it("lists but does not copy a file that is too big or not text", () => {
    const big = "x".repeat(CHECKPOINT_LIMITS.maxFileBytes + 1);
    const binary = `abc${String.fromCharCode(0)}def`;
    const { fsImpl } = run(write("big.txt"), { files: { "big.txt": big } });
    expect(manifestOf(fsImpl)?.files).toMatchObject([{ path: "big.txt", existed: true, skipped: "too-big" }]);
    const second = run(write("data.bin"), { files: { "data.bin": binary } });
    expect(manifestOf(second.fsImpl)?.files).toMatchObject([{ path: "data.bin", existed: true, skipped: "not-text" }]);
    expect(saved(second.fsImpl).filter((key) => key.includes("/files/"))).toEqual([]);
  });

  it("does nothing outside the project", () => {
    const { out, fsImpl } = run({ tool_name: "Write", tool_input: { file_path: "/elsewhere/x.txt", content: "a" } });
    expect(out.exitCode).toBe(2);
    expect(saved(fsImpl)).toEqual([]);
  });

  it("stops saving at the count limit and never deletes", () => {
    const index = `${JSON.stringify({ id: "x", bytes: 1 })}\n`.repeat(CHECKPOINT_LIMITS.maxCount);
    const { out, fsImpl } = run(write("src/a.ts"), { files: { "src/a.ts": "old", [`${CHECKPOINT_DIR}/index.log`]: index } });
    expect(out.exitCode).toBe(0);
    expect(saved(fsImpl)).toEqual([]);
    expect(fsImpl.files.get(`${STORE}/index.log`)).toBe(index);
  });

  it("stops saving at the total size limit, and when one more would pass it", () => {
    const full = `${JSON.stringify({ id: "x", bytes: CHECKPOINT_LIMITS.maxTotalBytes })}\n`;
    expect(saved(run(write("src/a.ts"), { files: { "src/a.ts": "old", [`${CHECKPOINT_DIR}/index.log`]: full } }).fsImpl)).toEqual([]);

    const nearly = `${JSON.stringify({ id: "x", bytes: CHECKPOINT_LIMITS.maxTotalBytes - 2 })}\n`;
    expect(saved(run(write("src/a.ts"), { files: { "src/a.ts": "four", [`${CHECKPOINT_DIR}/index.log`]: nearly } }).fsImpl)).toEqual([]);
  });

  it("is off when the setting is false, and when the run is not recorded", () => {
    expect(saved(run(write("src/a.ts"), { files: { "src/a.ts": "old" }, config: { checkpoints: false } }).fsImpl)).toEqual([]);
    expect(saved(run(write("src/a.ts"), { files: { "src/a.ts": "old" }, audit: false }).fsImpl)).toEqual([]);
  });

  it("never lets a failure change the answer", () => {
    const { out, fsImpl } = run(write("src/a.ts"), {
      files: { "src/a.ts": "old" },
      tweak: (fs) => {
        fs.writeFileSync = () => {
          throw new Error("disk full");
        };
      },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(fsImpl.files.get(`${ROOT}/src/a.ts`)).toBe("old");
  });

  it("does not save for reads, shell commands or other tools", () => {
    expect(saved(run({ tool_name: "Read", tool_input: { file_path: `${ROOT}/src/a.ts` } }, { files: { "src/a.ts": "old" } }).fsImpl)).toEqual([]);
    expect(saved(run({ tool_name: "Bash", tool_input: { command: "ls" } }, { files: { "src/a.ts": "old" } }).fsImpl)).toEqual([]);
  });

  it("validates the setting", () => {
    const { out } = run(write("src/a.ts"), { config: { checkpoints: "yes" } });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toMatch(/bad-config/);
  });
});
