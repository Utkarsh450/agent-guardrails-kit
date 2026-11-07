/**
 * A tiny stand-in for the browser DOM, just enough to run the dashboard script and read back the text it shows.
 * Like a real browser, appending something that is not a node turns it into text with String(), so a mistake such
 * as passing an array shows up as "[object ...]" or "null" in the output, exactly as it would on screen.
 */
export class FakeNode {
  children: FakeNode[] = [];
  text = "";
  tag = "#text";
  attrs: Record<string, string> = {};
  className = "";
  dataset: Record<string, string> = {};
  value = "";
  listeners: Record<string, Array<() => void>> = {};

  append(...kids: unknown[]): void {
    for (const kid of kids) this.children.push(kid instanceof FakeNode ? kid : text(String(kid)));
  }
  replaceChildren(...kids: unknown[]): void {
    this.children = [];
    this.append(...kids);
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  click(): void {
    for (const fn of this.listeners.click ?? []) fn();
  }
  focus(): void {}
  select(): void {}
  remove(): void {}
  get textContent(): string {
    return this.tag === "#text" ? this.text : this.children.map((c) => c.textContent).join(" ");
  }
  set textContent(value: string) {
    this.children = [text(value)];
  }
  find(predicate: (n: FakeNode) => boolean): FakeNode[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap((c) => c.find(predicate))];
  }
}

function text(value: string): FakeNode {
  const node = new FakeNode();
  node.text = value;
  return node;
}

export function createFakeDom(hash: string, handler: (url: string) => Promise<{ status: number; body: string }>) {
  const byId = new Map<string, FakeNode>();
  for (const id of ["main", "brand", "project"]) {
    const node = new FakeNode();
    node.tag = "div";
    byId.set(id, node);
  }
  const body = new FakeNode();
  body.tag = "body";
  const document = {
    title: "",
    body,
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: () => [] as FakeNode[],
    createTextNode: (value: string) => text(String(value)),
    createElement: (tag: string) => {
      const node = new FakeNode();
      node.tag = tag;
      return node;
    },
    execCommand: () => true,
  };
  const listeners: Record<string, Array<() => void>> = {};
  const window = { addEventListener: (type: string, fn: () => void) => (listeners[type] ??= []).push(fn) };
  const location = { hash };
  const fetchImpl = async (url: string) => {
    const result = await handler(url);
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => JSON.parse(result.body) as unknown };
  };
  const navigator = { clipboard: { writeText: async () => undefined } };
  return { document, window, location, fetch: fetchImpl, navigator, Node: FakeNode, byId, fire: (type: string) => (listeners[type] ?? []).forEach((fn) => fn()) };
}

/** Runs the dashboard script against a fake page and waits until it has finished loading. */
export async function renderDashboard(script: string, hash: string, handler: (url: string) => Promise<{ status: number; body: string }>) {
  const env = createFakeDom(hash, handler);
  new Function("document", "window", "location", "fetch", "navigator", "Node", script)(env.document, env.window, env.location, env.fetch, env.navigator, env.Node);
  const main = env.byId.get("main")!;
  const brand = env.byId.get("brand")!;
  // Wait for the tab and for the header, which the script fills from a second request.
  for (let i = 0; i < 200 && (main.textContent.includes("Loading...") || main.children.length === 0 || brand.textContent === ""); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { ...env, main, screen: () => main.textContent };
}
