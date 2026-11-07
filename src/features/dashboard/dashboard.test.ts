import { createHash } from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderDashboard } from "../../../tests/helpers/fake-dom.ts";
import { ScriptedUi } from "../../../tests/helpers/scripted-ui.ts";
import { runDashboard } from "../commands/dashboard.ts";
import { CliError } from "../commands/errors.ts";
import { runInit } from "../commands/init.ts";
import { APP_CSS, APP_JS, INDEX_HTML } from "./assets.ts";
import { createDashboard, isAllowedHost, startDashboard, type Dashboard } from "./server.ts";

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-guardrails-dash-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

async function installed(agents = "claude,codex,antigravity"): Promise<string> {
  const root = await project({ "package.json": JSON.stringify({ name: "demo", packageManager: "pnpm@11.0.0" }) });
  await runInit({ cwd: root, ui: new ScriptedUi([], false) }, { agents, yes: true });
  return root;
}

/** Hash of every file under a folder, to prove the dashboard changes nothing. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out[path.relative(dir, abs)] = createHash("sha256").update(await readFile(abs)).digest("hex") + (await stat(abs)).size;
    }
  };
  await walk(dir);
  return out;
}

describe("dashboard routes", () => {
  let root: string;
  let dash: Dashboard;
  const get = (url: string, headers: Record<string, string> = {}) => dash.app.inject({ method: "GET", url, headers });

  beforeAll(async () => {
    root = await installed();
    dash = await createDashboard({ root });
    await dash.app.ready();
  });
  afterAll(async () => {
    await dash.app.close();
  });

  it("serves the page, the style and the script", async () => {
    const page = await get("/");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toBe(INDEX_HTML);
    expect(page.body).toContain('<script src="/app.js" defer>');
    expect(page.body).not.toMatch(/<script>[^<]/); // no inline scripts, so the strict CSP holds
    expect((await get("/app.css")).body).toBe(APP_CSS);
    expect((await get("/app.js")).headers["content-type"]).toContain("javascript");
  });

  it("ships a script that parses, builds the page without innerHTML, and never evaluates strings", () => {
    expect(() => new Function(APP_JS)).not.toThrow();
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setTimeout(\""]) {
      expect(APP_JS, banned).not.toContain(banned);
    }
    expect(APP_JS).not.toMatch(/https?:\/\/(?!127)/); // nothing is fetched from anywhere else
  });

  it("skips empty slots when building a page, so the word \"null\" never shows up on screen", () => {
    expect(APP_JS).toMatch(/function show\(\.\.\.nodes\) \{ main\.replaceChildren\(\.\.\.nodes\.flat\(\)\.filter\(\(node\) => node != null && node !== false\)\); \}/);
  });

  it("overview: protection per agent, settings and the doctor report", async () => {
    const data = (await get("/api/overview")).json();
    expect(data.tool.name).toBe("agent-guardrails-kit");
    expect(data.project).toEqual({ folder: path.basename(root), configured: true });
    expect(data.settings).toMatchObject({ preset: "balanced", policy: "ask", approvalGate: true, agents: ["claude", "codex", "antigravity"] });
    expect(data.protection.map((p: { agent: string }) => p.agent)).toEqual(["claude", "cursor", "codex", "antigravity", "qoder"]);
    expect(data.protection.find((p: { agent: string }) => p.agent === "claude")).toMatchObject({ enforcement: "enforced", configured: true });
    expect(data.protection.find((p: { agent: string }) => p.agent === "antigravity")).toMatchObject({ enforcement: "advisory", configured: true });
    expect(data.protection.find((p: { agent: string }) => p.agent === "cursor").configured).toBe(false);
    expect(data.doctor.counts.fail).toBe(0);
    expect(data.doctor.checks.length).toBeGreaterThan(8);
  });

  it("plan: a configured project has nothing left to do", async () => {
    const data = (await get("/api/plan")).json();
    expect(data.basedOn).toMatch(/saved settings/);
    expect(data.counts.create + data.counts.update).toBe(0);
    expect(data.entries.length).toBeGreaterThan(15);
    expect(data.entries.every((e: { status: string }) => ["unchanged", "kept"].includes(e.status))).toBe(true);
    expect(data.notes.some((n: { title: string }) => n.title === "codex")).toBe(true);
  });

  it("plan: an empty project shows what init would create, with diffs for existing files", async () => {
    const fresh = await project({ ".gitignore": "node_modules/\n", "CLAUDE.md": "mine" });
    const d = await createDashboard({ root: fresh });
    const data = (await d.app.inject({ method: "GET", url: "/api/plan" })).json();
    expect(data.basedOn).toMatch(/what `init` would do/);
    expect(data.counts.create).toBeGreaterThan(10);
    const gitignore = data.entries.find((e: { path: string }) => e.path === ".gitignore");
    expect(gitignore.status).toBe("update");
    expect(gitignore.diff).toContain("+# >>> agent-guardrails");
    expect(data.entries.find((e: { path: string }) => e.path === "CLAUDE.md").status).toBe("kept");
    await d.app.close();
  });

  it("activity: empty, then with the log the guard wrote", async () => {
    const empty = (await get("/api/activity")).json();
    expect(empty.exists).toBe(false);
    expect(Object.keys(empty.titles).length).toBeGreaterThan(30);

    const log = [
      { ts: "2026-11-05T10:00:00.000Z", agent: "claude", tool: "Bash", decision: "deny", rule: "file-deletion", detail: "rm -rf dist" },
      { ts: "2026-11-05T10:01:00.000Z", agent: "claude", tool: "Bash", decision: "ask", rule: "unknown-command", detail: "python x.py" },
      { ts: "2026-11-05T10:02:00.000Z", agent: "cursor", tool: "Bash", decision: "deny", rule: "git-write", detail: "<script>alert(1)</script>" },
    ].map((e) => JSON.stringify(e)).join("\n");
    await writeFile(path.join(root, ".agent-guardrails/audit.log"), `${log}\n`, "utf8");
    const data = (await get("/api/activity?limit=2")).json();
    expect(data.exists).toBe(true);
    expect(data.summary.total).toBe(3);
    expect(data.summary.byDecision).toEqual({ allow: 0, ask: 1, deny: 2 });
    expect(data.recent).toHaveLength(2);
    expect(data.recent[0].rule).toBe("git-write");
    // hostile text arrives as plain JSON data, with a JSON content type
    expect((await get("/api/activity")).headers["content-type"]).toContain("application/json");
    expect((await get("/api/activity?limit=banana")).statusCode).toBe(200);
    expect((await get("/api/activity?limit=100000")).json().recent.length).toBeLessThanOrEqual(100);
  });

  it("prompts: one per agent plus the gap review with the doctor report inside", async () => {
    const data = (await get("/api/prompts")).json();
    expect(data.agents).toHaveLength(5);
    expect(data.test.codex).toContain("Codex cannot ask me questions");
    expect(data.test.antigravity).toContain("no hooks");
    expect(data.gapReview).toContain("Guardrail gap review");
    expect(data.gapReview).toMatch(/\d+ ok, \d+ warning\(s\)/);
    expect(data.howTo).toHaveLength(3);
  });

  it("explain: an index, details, and a 404 for anything else", async () => {
    const index = (await get("/api/explain")).json();
    expect(index.rules.find((r: { id: string }) => r.id === "file-deletion")).toMatchObject({ title: "Deleting files", kind: "blocked" });
    expect(index.topics).toContain("approval");
    const detail = (await get("/api/explain/git-write")).json();
    expect(detail.title).toContain("git-write");
    expect(detail.lines.join(" ")).toContain("Why:");
    for (const bad of ["/api/explain/nonsense", "/api/explain/..%2f..%2fetc%2fpasswd", `/api/explain/${"a".repeat(80)}`, "/api/explain/%00"]) {
      expect([404, 414], bad).toContain((await get(bad)).statusCode); // 414: the name is longer than any real one
    }
  });

  it("never serves files: unknown and traversal paths are 404", async () => {
    for (const url of ["/etc/passwd", "/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/package.json", "/.env", "/agent-guardrails.config.json", "/app.js/../package.json"]) {
      const response = await get(url);
      expect([404, 400], url).toContain(response.statusCode);
      expect(response.body, url).not.toContain("root:");
    }
  });

  it("changes nothing on disk, whatever is requested", async () => {
    const before = await snapshot(root);
    for (const url of ["/", "/app.js", "/app.css", "/api/overview", "/api/plan", "/api/activity", "/api/prompts", "/api/explain", "/api/explain/approval", "/nope"]) await get(url);
    expect(await snapshot(root)).toEqual(before);
  });
});

describe("what the page actually shows (the real script, run against a fake DOM)", () => {
  let root: string;
  let dash: Dashboard;
  const handler = async (url: string) => {
    const response = await dash.app.inject({ method: "GET", url });
    return { status: response.statusCode, body: response.body };
  };

  beforeAll(async () => {
    root = await installed("claude,codex,antigravity");
    const log = [
      { ts: "2026-11-05T10:00:00.000Z", agent: "claude", tool: "Bash", decision: "deny", rule: "file-deletion", detail: "rm -rf dist" },
      { ts: "2026-11-05T10:01:00.000Z", agent: "codex", tool: "Bash", decision: "ask", rule: "unknown-command", detail: "python x.py" },
    ].map((e) => JSON.stringify(e)).join("\n");
    await writeFile(path.join(root, ".agent-guardrails/audit.log"), `${log}\n`, "utf8");
    dash = await createDashboard({ root });
    await dash.app.ready();
  });
  afterAll(async () => {
    await dash.app.close();
  });

  const tabs: Array<[string, string[]]> = [
    ["#overview", ["Overview", "Protection by agent", "Claude Code", "Enforced", "Advisory only", "balanced preset"]],
    ["#plan", ["Setup plan", "Already fine", "agent-rules/always/safety.md", "agent-guardrails update"]],
    ["#activity", ["Activity", "Most common reasons", "Deleting files", "rm -rf dist", "Unknown command"]],
    ["#prompts", ["Test prompts", "Guardrail test", "Gap review", "Copy prompt"]],
    ["#explain", ["Explain", "Changing git", "Asks you first", "Topics"]],
    ["#explain:git-write", ["git-write: Changing git", "Why:", "What to do:"]],
    ["#explain:no-approved-plan", ["No approved plan", "agent-guardrails approve"]],
  ];

  it.each(tabs)("%s shows real content and never prints null, undefined or [object ...]", async (hash, expected) => {
    const page = await renderDashboard(APP_JS, hash, handler);
    const screen = page.screen();
    for (const text of expected) expect(screen, text).toContain(text);
    for (const bad of ["null", "undefined", "[object", "NaN", "Something went wrong", "Loading..."]) expect(screen, bad).not.toContain(bad);
    expect(page.byId.get("brand")!.textContent).toContain("agent-guardrails-kit v");
    expect(page.byId.get("project")!.textContent).toContain(path.basename(root));
  });

  it("shows the setup call to action when the project is not set up yet", async () => {
    const empty = await createDashboard({ root: await project() });
    const emptyHandler = async (url: string) => {
      const response = await empty.app.inject({ method: "GET", url });
      return { status: response.statusCode, body: response.body };
    };
    const page = await renderDashboard(APP_JS, "#overview", emptyHandler);
    expect(page.screen()).toContain("Not set up yet.");
    expect(page.screen()).toContain("agent-guardrails init");
    expect(page.screen()).not.toContain("null");
    await empty.app.close();
  });

  it("shows an error message, not a blank page, when the server fails", async () => {
    const page = await renderDashboard(APP_JS, "#plan", async () => ({ status: 500, body: "{}" }));
    expect(page.screen()).toContain("Something went wrong");
    expect(page.screen()).toContain("Could not load /api/plan (500)");
  });

  it("puts hostile text from the project on the screen as plain text", async () => {
    const hostile = await project();
    await mkdir(path.join(hostile, ".agent-guardrails"), { recursive: true });
    await writeFile(path.join(hostile, ".agent-guardrails/audit.log"), `${JSON.stringify({ ts: "2026-11-05T10:00:00.000Z", agent: "claude", tool: "Bash", decision: "deny", rule: "git-write", detail: "<img src=x onerror=alert(1)>" })}\n`, "utf8");
    const d = await createDashboard({ root: hostile });
    const page = await renderDashboard(APP_JS, "#activity", async (url) => {
      const response = await d.app.inject({ method: "GET", url });
      return { status: response.statusCode, body: response.body };
    });
    expect(page.screen()).toContain("<img src=x onerror=alert(1)>");
    expect(page.main.find((n) => n.tag === "img")).toEqual([]); // it is text, not an element
    await d.app.close();
  });
});

describe("dashboard security", () => {
  let dash: Dashboard;
  beforeAll(async () => {
    dash = await createDashboard({ root: await installed("claude") });
    await dash.app.ready();
  });
  afterAll(async () => {
    await dash.app.close();
  });

  it("is read-only: every method except GET and HEAD is refused, and no such route exists", async () => {
    expect([...dash.methods].sort()).toEqual(["GET", "HEAD"]);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      for (const url of ["/", "/api/overview", "/api/approve", "/api/plan"]) {
        const response = await dash.app.inject({ method, url, payload: method === "OPTIONS" ? undefined : { x: 1 } });
        expect(response.statusCode, `${method} ${url}`).toBe(405);
        expect(response.headers.allow).toBe("GET, HEAD");
      }
    }
  });

  it("answers HEAD requests without a body", async () => {
    const response = await dash.app.inject({ method: "HEAD", url: "/api/overview" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
  });

  it("only answers to loopback host names (DNS rebinding protection)", async () => {
    for (const host of ["127.0.0.1:4747", "localhost:4747", "localhost", "[::1]:4747", "LOCALHOST:1"]) {
      expect((await dash.app.inject({ method: "GET", url: "/api/overview", headers: { host } })).statusCode, host).toBe(200);
    }
    for (const host of ["evil.example", "evil.example:4747", "127.0.0.1.evil.example", "localhost.evil.example", "192.168.1.5:4747", "0.0.0.0:4747"]) {
      expect((await dash.app.inject({ method: "GET", url: "/api/overview", headers: { host } })).statusCode, host).toBe(403);
    }
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost("")).toBe(false);
  });

  it("refuses requests that come from other websites", async () => {
    const reject = [{ origin: "https://evil.example" }, { origin: "http://evil.example" }, { origin: "http://127.0.0.1.evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }];
    for (const headers of reject) {
      expect((await dash.app.inject({ method: "GET", url: "/api/overview", headers })).statusCode, JSON.stringify(headers)).toBe(403);
    }
    const accept = [{ origin: "http://127.0.0.1:4747" }, { origin: "http://localhost:4747" }, { "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }];
    for (const headers of accept) {
      expect((await dash.app.inject({ method: "GET", url: "/api/overview", headers })).statusCode, JSON.stringify(headers)).toBe(200);
    }
  });

  it("sends strict security headers on every response, errors included, and no CORS headers", async () => {
    for (const url of ["/", "/api/overview", "/nope"]) {
      const response = await dash.app.inject({ method: "GET", url });
      expect(response.headers["content-security-policy"], url).toContain("default-src 'none'");
      expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers["content-security-policy"]).toContain("form-action 'none'");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const blocked = await dash.app.inject({ method: "POST", url: "/" });
    expect(blocked.headers["content-security-policy"]).toBeDefined();
  });
});

/** A plain HTTP request that sets the Host header itself (fetch would replace it). */
function rawStatus(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/api/overview", method: "GET", headers: { Host: host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("a real listening dashboard", () => {
  it("binds to the loopback address only and is not reachable from other addresses", async () => {
    const root = await installed("claude");
    const server = await startDashboard({ root, port: 0 });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(`${server.url}/api/overview`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { project: { configured: boolean } }).project.configured).toBe(true);

      const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
      if (external) {
        await expect(fetch(`http://${external.address}:${server.port}/api/overview`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
      }
      // fetch() overwrites the Host header, so send a raw request to prove a rebinding-style Host is refused.
      for (const host of ["evil.example", "evil.example:" + server.port, "127.0.0.1.evil.example"]) {
        expect(await rawStatus(server.port, host), JSON.stringify(host)).toBe(403);
      }
      expect(await rawStatus(server.port, `127.0.0.1:${server.port}`)).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("the ui command", () => {
  it("starts, says where it is and that it is read-only, serves, and stops cleanly", async () => {
    const root = await installed("claude");
    const ui = new ScriptedUi([], false);
    let seen = 0;
    const code = await runDashboard({ cwd: root, ui }, { port: 0 }, {
      waitForStop: async (server) => {
        seen = (await fetch(`${server.url}/api/overview`)).status;
      },
    });
    expect(code).toBe(0);
    expect(seen).toBe(200);
    expect(ui.text).toMatch(/Dashboard running at http:\/\/127\.0\.0\.1:\d+/);
    expect(ui.text).toContain("read-only");
    expect(ui.text).toContain("Dashboard stopped.");
  });

  it("opens the browser only when asked, and only at the loopback address", async () => {
    const root = await installed("claude");
    const opened: string[] = [];
    await runDashboard({ cwd: root, ui: new ScriptedUi([], false) }, { port: 0 }, { waitForStop: async () => undefined, openUrl: (u) => opened.push(u) });
    expect(opened).toEqual([]);
    await runDashboard({ cwd: root, ui: new ScriptedUi([], false) }, { port: 0, open: true }, { waitForStop: async () => undefined, openUrl: (u) => opened.push(u) });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("explains a busy port and a bad port", async () => {
    const root = await installed("claude");
    const first = await startDashboard({ root, port: 0 });
    try {
      await expect(runDashboard({ cwd: root, ui: new ScriptedUi([], false) }, { port: first.port }, { waitForStop: async () => undefined })).rejects.toThrow(/already in use/);
    } finally {
      await first.close();
    }
    for (const port of [-1, 70000, 1.5, Number.NaN]) {
      await expect(runDashboard({ cwd: root, ui: new ScriptedUi([], false) }, { port }, { waitForStop: async () => undefined })).rejects.toThrow(CliError);
    }
  });

  it("works from a subfolder of the project", async () => {
    const root = await installed("claude");
    await mkdir(path.join(root, "src"), { recursive: true });
    let body: { project: { folder: string } } | null = null;
    await runDashboard({ cwd: path.join(root, "src"), ui: new ScriptedUi([], false) }, { port: 0 }, {
      waitForStop: async (server) => {
        body = (await (await fetch(`${server.url}/api/overview`)).json()) as { project: { folder: string } };
      },
    });
    expect(body!.project.folder).toBe(path.basename(root));
  });
});
