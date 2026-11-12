/**
 * The dashboard page, served from fixed routes (no file paths are ever read from the request).
 * The script builds the page with textContent only, never innerHTML, so nothing read from the project can inject markup.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guardrails dashboard</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap bar">
    <div>
      <div class="brand" id="brand">agent-guardrails</div>
      <div class="muted small" id="project">Loading...</div>
    </div>
    <span class="chip s-info" title="This page can only show information. Anything that changes your project is a command you type yourself.">Read-only</span>
  </div>
  <nav class="wrap tabs" aria-label="Sections">
    <a href="#overview" data-tab="overview">Overview</a>
    <a href="#plan" data-tab="plan">Setup plan</a>
    <a href="#activity" data-tab="activity">Activity</a>
    <a href="#prompts" data-tab="prompts">Test prompts</a>
    <a href="#explain" data-tab="explain">Explain</a>
  </nav>
</header>
<main class="wrap" id="main" tabindex="-1"></main>
<footer class="wrap muted small">Local only. This page reads your project from your own machine and sends nothing anywhere. To change anything, run the command shown next to it.</footer>
<script src="/app.js" defer></script>
</body>
</html>
`;

export const APP_CSS = `
:root {
  color-scheme: light dark;
  --bg: #fafaf9; --surface: #ffffff; --text: #1c1917; --muted: #57534e; --line: #e7e5e4; --accent: #1d4ed8;
  --ok: #166534; --ok-bg: #dcfce7; --warn: #92400e; --warn-bg: #fef3c7; --fail: #991b1b; --fail-bg: #fee2e2; --info: #1e40af; --info-bg: #dbeafe;
  --code-bg: #f5f5f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14110f; --surface: #1c1917; --text: #f5f5f4; --muted: #a8a29e; --line: #2e2925; --accent: #93c5fd;
    --ok: #86efac; --ok-bg: #14301f; --warn: #fcd34d; --warn-bg: #33270d; --fail: #fca5a5; --fail-bg: #3a1515; --info: #93c5fd; --info-bg: #14233d;
    --code-bg: #0f0d0c;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 980px; margin: 0 auto; padding: 0 16px; }
.skip { position: absolute; left: -9999px; }
.skip:focus { left: 16px; top: 8px; background: var(--surface); padding: 6px 10px; border-radius: 6px; z-index: 5; }
.top { background: var(--surface); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 3; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; padding-bottom: 8px; }
.brand { font-weight: 700; font-size: 17px; }
.tabs { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 8px; }
.tabs a { padding: 6px 12px; border-radius: 8px; color: var(--muted); text-decoration: none; white-space: nowrap; }
.tabs a:hover { color: var(--text); background: var(--bg); }
.tabs a[aria-current="page"] { color: var(--accent); background: var(--info-bg); font-weight: 600; }
main { padding-top: 20px; padding-bottom: 32px; outline: none; }
footer { padding-bottom: 32px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 28px 0 8px; }
p { margin: 8px 0; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin: 10px 0; }
.grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.stat b { display: block; font-size: 24px; line-height: 1.2; }
.chip { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.s-ok { color: var(--ok); background: var(--ok-bg); }
.s-warn { color: var(--warn); background: var(--warn-bg); }
.s-fail { color: var(--fail); background: var(--fail-bg); }
.s-info { color: var(--info); background: var(--info-bg); }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); background: var(--bg); }
tr:last-child td { border-bottom: 0; }
.check { display: grid; grid-template-columns: 78px 1fr; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line); }
.check:last-child { border-bottom: 0; }
.check .t { font-weight: 600; }
code, pre, textarea { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { background: var(--code-bg); padding: 1px 6px; border-radius: 6px; }
pre { background: var(--code-bg); padding: 10px 12px; border-radius: 8px; overflow-x: auto; margin: 6px 0; }
textarea { width: 100%; min-height: 260px; background: var(--code-bg); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.fix { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
button, select { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 4px 12px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.callout { border-left: 4px solid var(--accent); background: var(--info-bg); padding: 10px 14px; border-radius: 6px; margin: 12px 0; }
.files { list-style: none; padding: 0; margin: 4px 0; }
.files li { padding: 3px 0; }
.sym { display: inline-block; width: 1.4em; font-weight: 700; font-family: ui-monospace, Menlo, monospace; }
details { margin: 2px 0 2px 1.4em; }
summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.two { display: grid; grid-template-columns: 240px 1fr; gap: 16px; }
.list button { display: block; width: 100%; text-align: left; margin: 2px 0; }
.list button[aria-pressed="true"] { border-color: var(--accent); background: var(--info-bg); }
@media (max-width: 700px) { .two { grid-template-columns: 1fr; } .check { grid-template-columns: 1fr; } }
`;

export const APP_JS = `
(() => {
  "use strict";
  const main = document.getElementById("main");
  const STATUS = { ok: ["OK", "s-ok"], warn: ["Warning", "s-warn"], fail: ["Problem", "s-fail"], info: ["Note", "s-info"] };
  const PLAN_SYMBOL = { create: "+", update: "~", unchanged: "=", kept: "-", conflict: "!" };
  const PLAN_WORD = { create: "will be created", update: "will be updated", unchanged: "already fine", kept: "yours, kept as it is", conflict: "needs attention" };

  /** Builds an element. Text is always added as text, never as HTML. */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === false || value == null) continue;
      if (key === "class") el.className = value;
      else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? "" : String(value));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(path) {
    const response = await fetch(path, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Could not load " + path + " (" + response.status + ")");
    return response.json();
  }

  function chip(status) {
    const [label, cls] = STATUS[status] || STATUS.info;
    return h("span", { class: "chip " + cls }, label);
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = h("textarea", { "aria-hidden": "true", style: "position:fixed;left:-9999px" });
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    const old = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = old; }, 1500);
  }

  function copyButton(getText, label) {
    const button = h("button", { type: "button" }, label || "Copy");
    button.addEventListener("click", () => copyText(getText(), button));
    return button;
  }

  /** A command the person can copy and run in their own terminal. */
  function command(text) {
    return h("span", { class: "fix" }, h("code", null, text), copyButton(() => text));
  }

  function show(...nodes) { main.replaceChildren(...nodes.flat().filter((node) => node != null && node !== false)); }

  // ───────── Overview ─────────
  async function overview() {
    const data = await api("/api/overview");
    document.getElementById("brand").textContent = data.tool.name + " v" + data.tool.version;
    document.getElementById("project").textContent = "Project folder: " + data.project.folder;
    document.title = data.project.folder + " | Guardrails dashboard";

    const counts = data.doctor.counts;
    const areas = [...new Set(data.doctor.checks.map((c) => c.area))];
    show(
      h("h1", null, "Overview"),
      h("p", { class: "muted" }, "Is this project protected, and what is only a request to the agent?"),
      data.project.configured ? null : h("div", { class: "callout" }, h("b", null, "Not set up yet. "), "Run ", command("agent-guardrails-kit init"), " in your project folder."),
      h("div", { class: "grid" },
        stat(counts.ok, "OK", "s-ok"), stat(counts.warn, "Warnings", "s-warn"), stat(counts.fail, "Problems", "s-fail"), stat(counts.info, "Notes", "s-info")),
      h("h2", null, "Protection by agent"),
      h("table", null,
        h("thead", null, h("tr", null, h("th", null, "Agent"), h("th", null, "Protection"), h("th", null, "Set up here"))),
        h("tbody", null, data.protection.map((p) => h("tr", null,
          h("td", null, p.label),
          h("td", null, p.enforcement === "enforced"
            ? h("span", null, h("span", { class: "chip s-ok" }, "Enforced"), " a hook can block actions")
            : h("span", null, h("span", { class: "chip s-warn" }, "Advisory only"), " no hooks; rules are only a request")),
          h("td", null, p.configured ? "Yes" : "No"))))),
      data.settings ? settingsCard(data.settings) : null,
      areas.map((area) => h("section", null,
        h("h2", null, area),
        h("div", { class: "card" }, data.doctor.checks.filter((c) => c.area === area).map((c) => h("div", { class: "check" },
          h("div", null, chip(c.status)),
          h("div", null,
            h("div", { class: "t" }, c.title),
            c.detail ? h("div", { class: "muted" }, c.detail) : null,
            c.fix && c.status !== "ok" ? h("div", { class: "fix" }, "Fix: ", command(c.fix)) : null))))))
    );
  }

  function stat(value, label, cls) {
    return h("div", { class: "stat" }, h("b", null, String(value)), h("span", { class: "chip " + cls }, label));
  }

  function settingsCard(s) {
    return h("div", { class: "card" },
      h("div", null, h("b", null, "Settings: "), s.preset + " preset, " + s.stack + " stack"),
      h("div", { class: "muted" }, "Unknown commands: " + (s.policy === "ask" ? "the guard asks you" : s.policy) + ". Plan approval: " + (s.approvalGate ? "required before files change" : "OFF") + ". Commands allowed without asking: " + s.allowedCommands + "."),
      h("div", { class: "muted" }, "Change settings with ", command("agent-guardrails-kit preset <name>"), " or ", command("agent-guardrails-kit allow add \\"<command>\\"")));
  }

  // ───────── Setup plan ─────────
  async function plan() {
    const data = await api("/api/plan");
    const groups = [["rules", "Rules and generated agent files"], ["config", "Settings"], ["guard", "Guard"], ["agents", "Agent configs"], ["git", "Git hooks"], ["github", "GitHub files"]];
    const c = data.counts;
    show(
      h("h1", null, "Setup plan"),
      h("p", { class: "muted" }, "What the tool would write, based on " + data.basedOn + ". Nothing here is applied from this page."),
      h("div", { class: "grid" }, stat(c.create, "To create", "s-info"), stat(c.update, "To update", "s-warn"), stat(c.unchanged, "Already fine", "s-ok"), stat(c.kept + c.conflict, "Yours / attention", c.conflict > 0 ? "s-fail" : "s-info")),
      h("p", null, "To apply it, run ", command(data.basedOn.startsWith("your") ? "agent-guardrails-kit update" : "agent-guardrails-kit init")),
      groups.map(([key, title]) => {
        const rows = data.entries.filter((e) => e.group === key);
        if (rows.length === 0) return null;
        return h("section", null, h("h2", null, title), h("ul", { class: "files" }, rows.map((e) => h("li", null,
          h("span", { class: "sym", "aria-hidden": "true" }, PLAN_SYMBOL[e.status]),
          h("code", null, e.path), " ", h("span", { class: "muted small" }, PLAN_WORD[e.status]),
          e.status === "conflict" && e.reason ? h("div", { class: "muted small" }, e.reason) : null,
          e.diff ? h("details", null, h("summary", null, "What changes"), h("pre", null, e.diff)) : null))));
      }),
      data.warnings.map((w) => h("div", { class: "callout" }, w)),
      data.notes.length > 0 ? h("h2", null, "Steps only you can do") : null,
      data.notes.map((n) => h("div", { class: "card" }, h("b", null, n.title), n.lines.map((l) => h("div", { class: "muted" }, l))))
    );
  }

  // ───────── Activity ─────────
  async function activity() {
    const data = await api("/api/activity?limit=25");
    if (!data.exists || data.summary.total === 0) {
      show(h("h1", null, "Activity"), h("div", { class: "card" }, "Nothing recorded yet. The guard writes a local log the first time it blocks or asks about something."));
      return;
    }
    const s = data.summary;
    show(
      h("h1", null, "Activity"),
      h("p", { class: "muted" }, s.total + " recorded actions, from " + s.first + " to " + s.last + ". This log stays on your machine."),
      h("div", { class: "grid" }, stat(s.byDecision.deny, "Blocked", "s-fail"), stat(s.byDecision.ask, "Asked", "s-warn"), stat(s.byDecision.allow, "Allowed (logged)", "s-ok")),
      h("h2", null, "Most common reasons"),
      h("table", null,
        h("thead", null, h("tr", null, h("th", null, "Count"), h("th", null, "What"), h("th", null, "Reason"))),
        h("tbody", null, s.byRule.slice(0, 10).map((r) => h("tr", null,
          h("td", null, String(r.count)),
          h("td", null, r.decision === "deny" ? "Blocked" : r.decision === "ask" ? "Asked" : "Allowed"),
          h("td", null, h("a", { href: "#explain:" + r.rule }, data.titles[r.rule] || r.rule), " ", h("span", { class: "muted small" }, r.rule)))))),
      h("h2", null, "Most recent blocked or asked actions"),
      h("table", null,
        h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "Agent"), h("th", null, "What"), h("th", null, "Action"))),
        h("tbody", null, data.recent.map((e) => h("tr", null,
          h("td", null, e.ts.replace("T", " ").slice(0, 19)),
          h("td", null, e.agent),
          h("td", null, e.decision === "deny" ? "Blocked" : "Asked", " ", h("span", { class: "muted small" }, e.rule)),
          h("td", null, h("code", null, e.detail.length > 90 ? e.detail.slice(0, 89) + "..." : e.detail)))))),
      data.skipped > 0 ? h("div", { class: "callout" }, data.skipped + " line(s) of the log could not be read.") : null
    );
  }

  // ───────── Test prompts ─────────
  async function prompts() {
    const data = await api("/api/prompts");
    let agent = data.agents[0].id;
    const area = h("textarea", { readonly: true, "aria-label": "Prompt text", rows: "16" });
    const gap = h("textarea", { readonly: true, "aria-label": "Gap review prompt", rows: "12" });
    area.value = data.test[agent];
    gap.value = data.gapReview;
    const select = h("select", { "aria-label": "Which agent" }, data.agents.map((a) => h("option", { value: a.id }, a.label + (a.enforcement === "advisory" ? " (advisory only)" : ""))));
    select.addEventListener("change", () => { agent = select.value; area.value = data.test[agent]; });
    show(
      h("h1", null, "Test prompts"),
      h("p", { class: "muted" }, "Paste a prompt into an AI agent to find out whether the protections really hold. Each probe is harmless if it somehow ran, but only ever use a throwaway copy."),
      h("ol", null, data.howTo.map((t) => h("li", null, t))),
      h("h2", null, "1. Guardrail test"),
      h("div", { class: "fix" }, h("label", null, "Agent: "), select, copyButton(() => area.value, "Copy prompt")),
      area,
      h("h2", null, "2. Gap review (read only)"),
      h("p", { class: "muted" }, "Asks an agent what could still go wrong. It includes the current doctor report."),
      h("div", { class: "fix" }, copyButton(() => gap.value, "Copy prompt")),
      gap
    );
  }

  // ───────── Explain ─────────
  async function explain(selected) {
    const index = await api("/api/explain");
    const detail = h("div", { class: "card" }, "Pick something on the left.");
    const buttons = new Map();

    async function open(name) {
      for (const [key, btn] of buttons) btn.setAttribute("aria-pressed", String(key === name));
      try {
        const data = await api("/api/explain/" + encodeURIComponent(name));
        detail.replaceChildren(h("h2", { style: "margin-top:0" }, data.title), ...data.lines.map((l) => (l === "" ? h("br") : h("div", null, l))));
      } catch (error) {
        detail.replaceChildren(h("div", null, String(error.message || error)));
      }
    }
    const item = (name, label) => {
      const btn = h("button", { type: "button", "aria-pressed": "false" }, label);
      btn.addEventListener("click", () => open(name));
      buttons.set(name, btn);
      return btn;
    };
    show(
      h("h1", null, "Explain"),
      h("p", { class: "muted" }, "Why the guard blocked or asked, in plain words. In a terminal: ", command("agent-guardrails-kit explain <name>")),
      h("div", { class: "two" },
        h("div", { class: "list" },
          h("h2", { style: "margin-top:0" }, "Blocked"), index.rules.filter((r) => r.kind === "blocked").map((r) => item(r.id, r.title)),
          h("h2", null, "Asks you first"), index.rules.filter((r) => r.kind === "asks").map((r) => item(r.id, r.title)),
          h("h2", null, "Topics"), index.topics.map((t) => item(t, t)),
          h("h2", null, "Agents"), index.agents.map((a) => item(a, a))),
        detail)
    );
    if (selected) open(selected);
  }

  // ───────── Routing ─────────
  const views = { overview, plan, activity, prompts, explain };
  async function route() {
    const [tab, arg] = (location.hash.slice(1) || "overview").split(":");
    const name = views[tab] ? tab : "overview";
    for (const a of document.querySelectorAll("[data-tab]")) {
      if (a.dataset.tab === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
    show(h("p", { class: "muted" }, "Loading..."));
    try {
      await views[name](arg);
    } catch (error) {
      show(h("h1", null, "Something went wrong"), h("div", { class: "card" }, String(error.message || error)));
    }
    main.focus({ preventScroll: true });
  }
  window.addEventListener("hashchange", route);
  route();
  // Fill the header even when another tab is open first.
  api("/api/overview").then((d) => {
    document.getElementById("brand").textContent = d.tool.name + " v" + d.tool.version;
    document.getElementById("project").textContent = "Project folder: " + d.project.folder;
  }).catch(() => {});
})();
`;
