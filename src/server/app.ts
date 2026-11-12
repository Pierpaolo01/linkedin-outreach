import { readFileSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import type { Db } from "../db/index";
import { registerCampaignRoutes } from "./campaignRoutes";
import { registerDashboardRoutes } from "./dashboardRoutes";
import { NO_BODY_ERROR, noBody, sessionJson } from "./http";
import { registerOpsRoutes, type OpsDeps } from "./opsRoutes";
import { registerScreenshotRoutes } from "./screenshotRoutes";
import { readSession, type SessionCheck } from "./sessionStore";

export interface ServerOptions {
  readonly db: Db;
  /** Runs and stores session checks; shared with the startup check so only one runs at a time. */
  readonly session: SessionCheck;
  /** The built UI (`dist/ui`). */
  readonly uiDir: string;
  /** The port the app listens on. Requests must name it in their Host header. */
  readonly port: number;
  readonly logger?: FastifyServerOptions["logger"];
  /** The clock every write is stamped with. */
  readonly now?: () => Date;
  /** Backups, auto-start, keep-awake and the AI test (`opsRoutes.ts`). Left out, those routes are not served. */
  readonly ops?: OpsDeps;
  /** The data directory's `screenshots/` folder (`screenshotRoutes.ts`). Left out, no screenshot is served. */
  readonly screenshotsDir?: string;
}

const packageJson = z.object({ version: z.string() });
const VERSION = packageJson.parse(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))).version;

/**
 * The app's web server: the JSON API and the built dashboard on one port.
 * It binds to 127.0.0.1 (see `main.ts`) and refuses any request whose Host
 * header is not this app, so a web page cannot reach it through DNS
 * rebinding. It sends no CORS headers, and refuses writes from other origins.
 */
export function buildServer({ db, session, uiDir, port, logger = false, now = () => new Date(), ops, screenshotsDir }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger });
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

  app.addHook("onRequest", async (request, reply) => {
    if (!allowedHosts.has(request.headers.host ?? "")) {
      return reply.code(403).send({ error: "Forbidden host" });
    }
    const origin = request.headers.origin;
    if (request.method !== "GET" && request.method !== "HEAD" && origin !== undefined && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: "Forbidden origin" });
    }
    return undefined;
  });

  app.get("/api/health", async (_request, reply) => {
    let dbOk: boolean;
    try {
      db.get(sql`select 1`);
      dbOk = true;
    } catch {
      dbOk = false;
    }
    return reply.code(dbOk ? 200 : 503).send({ ok: dbOk, version: VERSION, dbOk });
  });

  app.get("/api/session", async () => sessionJson(readSession(db), session.running));

  app.post("/api/session/check", async (request, reply) => {
    if (!noBody.safeParse(request.body).success) {
      return reply.code(400).send(NO_BODY_ERROR);
    }
    const outcome = await session.run();
    switch (outcome.kind) {
      case "busy":
        return reply.code(409).send({ error: "A session check is already running" });
      case "failed":
        return reply.code(502).send({ error: outcome.error, session: sessionJson(outcome.session, false) });
      case "checked":
        return reply.send(sessionJson(outcome.session, false));
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  });

  registerCampaignRoutes(app, { db, now });
  registerDashboardRoutes(app, { db, session, now });
  if (ops !== undefined) registerOpsRoutes(app, { ...ops, db });
  if (screenshotsDir !== undefined) registerScreenshotRoutes(app, { screenshotsDir });

  // Every error the API answers is `{ error }`: a request the app could not read (bad JSON, too
  // large) keeps its 4xx status; anything else is a 500 whose details go to the log only.
  app.setErrorHandler((error, request, reply) => {
    const status = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: error instanceof Error ? error.message : "Bad request" });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "Something went wrong in the app. The log has the details." });
  });

  void app.register(fastifyStatic, { root: uiDir, index: "index.html" });

  // Not an API route or a file: a page of the single-page app, so send the app.
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const lastSegment = path.split("/").at(-1) ?? "";
    if (request.method !== "GET" || path === "/api" || path.startsWith("/api/") || lastSegment.includes(".")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.type("text/html").sendFile("index.html");
  });

  return app;
}
