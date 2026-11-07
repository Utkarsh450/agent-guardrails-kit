import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../shared/agents.ts";
import { RULES, explain, listExplainable, suggestFor, topicNames } from "./index.ts";

/** Every rule id the guard can return, read from its source so a new rule cannot be forgotten. */
function guardRuleIds(): string[] {
  const source = readFileSync(new URL("../hooks/guard/guard.mjs", import.meta.url), "utf8");
  const ids = new Set<string>();
  for (const match of source.matchAll(/mk\(\s*(?:"(?:deny|ask|allow)"|ctx\.config\.policy[^,]*),\s*"([a-z-]+)"/g)) ids.add(match[1]!);
  return [...ids].sort();
}

describe("the explain catalog", () => {
  it("covers every rule id the guard can return", () => {
    const missing = guardRuleIds().filter((id) => !(id in RULES));
    expect(missing).toEqual([]);
  });

  it("has no entries for rules that do not exist", () => {
    const real = new Set(guardRuleIds());
    expect(Object.keys(RULES).filter((id) => !real.has(id))).toEqual([]);
  });

  it("gives every rule a title, a reason and a next step in plain words", () => {
    for (const [id, info] of Object.entries(RULES)) {
      expect(info.title.length, id).toBeGreaterThan(3);
      expect(info.why.length, id).toBeGreaterThan(20);
      expect(info.instead.length, id).toBeGreaterThan(10);
      expect(info.why + info.instead, id).not.toMatch(/—/);
    }
  });
});

describe("explain", () => {
  it("explains a rule", () => {
    const result = explain("file-deletion");
    expect(result?.title).toBe("file-deletion: Deleting files");
    expect(result?.lines[0]).toBe("The guard blocks this.");
    expect(result?.lines.join("\n")).toMatch(/Why:/);
    expect(explain("unknown-command")?.lines[0]).toBe("The guard asks you first.");
  });

  it("is forgiving about case and spaces", () => {
    expect(explain("  GIT-WRITE ")?.title).toContain("git-write");
  });

  it("explains each topic and each agent", () => {
    for (const topic of topicNames()) expect(explain(topic)?.lines.length, topic).toBeGreaterThan(0);
    for (const agent of AGENT_IDS) expect(explain(agent)?.lines.join(" ").length, agent).toBeGreaterThan(20);
    expect(explain("antigravity")?.lines.join("\n")).toContain("command(rm)");
    expect(explain("codex")?.lines.join("\n")).toMatch(/\/hooks/);
    expect(explain("claude")?.lines[0]).toMatch(/enforced/);
  });

  it("prints a branch-protection command with placeholders, never real names", () => {
    const text = explain("branch-protection")!.lines.join("\n");
    expect(text).toContain("repos/OWNER/REPO/branches/main/protection");
    expect(text).toContain("allow_force_pushes");
  });

  it("returns null for the unknown and suggests close names", () => {
    expect(explain("nonsense")).toBeNull();
    expect(suggestFor("git")).toEqual(expect.arrayContaining(["git-write", "git-option", "git"]));
    expect(suggestFor("delet")).toContain("file-deletion".includes("delet") ? "file-deletion" : "x");
  });

  it("lists everything it knows", () => {
    const all = listExplainable();
    expect(all.rules).toEqual(Object.keys(RULES).sort());
    expect(all.topics).toEqual(topicNames());
    expect(all.agents).toEqual([...AGENT_IDS]);
  });
});
