import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { explain } from "../explain/index.ts";
import { APP_CSS, APP_JS, INDEX_HTML } from "./assets.ts";
import { activity, explainIndex, overview, planPreview, prompts } from "./data.ts";

/**
 * A read-only dashboard served on the loopback address only.
 *
 * Why read-only: any program on this machine, including an AI agent, can send requests to localhost. A page
 * that could approve plans or change settings would be a way around the guard. So there are no routes that
 * change anything; every action stays a command the person types.
 */

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const LOOPBACK = "127.0.0.1";

/** The Host header must be a loopback name. A page on another domain that is re-pointed at this machine (DNS rebinding) fails this. */
export function isAllowedHost(header: string | undefined): boolean {
  if (!header) return false;
  const host = header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : (header.split(":")[0] ?? "");
  return ALLOWED_HOSTS.has(host.toLowerCase());
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ALLOWED_HOSTS.has(url.hostname.toLowerCase() === "::1" ? "[::1]" : url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function secure(reply: FastifyReply): FastifyReply {
  return reply
    .header("Content-Security-Policy", CSP)
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .header("Referrer-Policy", "no-referrer")
    .header("Cross-Origin-Resource-Policy", "same-origin")
    .header("Cache-Control", "no-store");
}

export interface DashboardOptions {
  /** The project folder to show. */
  root: string;
}

/** Methods of every route registered, so a test can prove nothing besides GET and HEAD exists. */
export interface Dashboard {
  app: FastifyInstance;
  methods: Set<string>;
}

export async function createDashboard({ root }: DashboardOptions): Promise<Dashboard> {
  let Fastify: typeof import("fastify").default;
  try {
    Fastify = (await import("fastify")).default;
  } catch {
    throw new Error("The dashboard needs the optional package \"fastify\", which is not installed. Install it (for example `npm install fastify`) and try again.");
  }

  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 60 } });
  const methods = new Set<string>();
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) methods.add(method);
  });

  // Every request: reads only, from loopback names only, from this page only.
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    secure(reply);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(405).header("Allow", "GET, HEAD").send({ error: "This dashboard is read-only." });
    }
    if (!isAllowedHost(request.headers.host)) {
      return reply.code(403).send({ error: "Unexpected host name. This dashboard only answers on 127.0.0.1 or localhost." });
    }
    const origin = request.headers.origin;
    if (typeof origin === "string" && !isAllowedOrigin(origin)) {
      return reply.code(403).send({ error: "Requests from other sites are not allowed." });
    }
    const site = request.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") {
      return reply.code(403).send({ error: "Requests from other sites are not allowed." });
    }
    return undefined;
  });

  const json = <T>(fn: () => Promise<T>) => async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.type("application/json; charset=utf-8");
    return fn();
  };

  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(INDEX_HTML));
  app.get("/app.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(APP_CSS));
  app.get("/app.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").send(APP_JS));

  app.get("/api/overview", json(() => overview(root)));
  app.get("/api/plan", json(() => planPreview(root)));
  app.get("/api/prompts", json(() => prompts(root)));
  app.get("/api/explain", json(async () => explainIndex()));
  app.get("/api/activity", async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply) => {
    reply.type("application/json; charset=utf-8");
    const limit = Number.parseInt(request.query.limit ?? "25", 10);
    return activity(root, Number.isFinite(limit) ? limit : 25);
  });
  app.get("/api/explain/:name", async (request: FastifyRequest<{ Params: { name: string } }>, reply) => {
    reply.type("application/json; charset=utf-8");
    const name = request.params.name;
    const found = /^[a-z0-9-]{1,40}$/i.test(name) ? explain(name) : null;
    if (found === null) return reply.code(404).send({ error: "Nothing to explain with that name." });
    return found;
  });

  app.setNotFoundHandler((_request, reply) => secure(reply).code(404).type("application/json").send({ error: "Not found." }));
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    return secure(reply).code(500).type("application/json").send({ error: message });
  });

  return { app, methods };
}

export interface RunningDashboard {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Starts the dashboard on 127.0.0.1. Port 0 picks a free port. */
export async function startDashboard(options: DashboardOptions & { port: number }): Promise<RunningDashboard> {
  const { app } = await createDashboard(options);
  await app.listen({ host: LOOPBACK, port: options.port });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return { url: `http://${LOOPBACK}:${port}`, port, close: () => app.close() };
}
