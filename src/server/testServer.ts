/**
 * Test harness for the API: the real server on a real SQLite file, a fake session port and a fixed
 * clock. Not used by the app.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type { Db } from "../db/index";
import { openTestDb } from "../campaigns/testSeed";
import { buildServer } from "./app";
import { createFakeSessionPort } from "./sessionPort";
import { createSessionCheck } from "./sessionStore";

export const PORT = 4747;
export const HOST = { host: `127.0.0.1:${PORT}` } as const;
/** Monday 16 November 2026, 10:00 in Europe/Rome: inside the default working window. */
export const NOW = new Date("2026-11-16T09:00:00Z");

export interface TestServer {
  readonly app: FastifyInstance;
  readonly db: Db;
  /** The data directory's `screenshots/` folder the server serves from. */
  readonly screenshotsDir: string;
  get(url: string, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  /** A JSON request with a body, or none when `body` is undefined. */
  send(method: "POST" | "PATCH", url: string, body?: unknown): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export function startTestServer(): TestServer {
  const t = openTestDb();
  const uiDir = join(t.dir, "ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>LinkedIn outreach</title>");
  const session = createSessionCheck({ db: t.db, port: createFakeSessionPort(["ok"]), now: () => NOW });
  const screenshotsDir = join(t.dir, "screenshots");
  mkdirSync(screenshotsDir, { recursive: true });
  const app = buildServer({ db: t.db, session, uiDir, port: PORT, now: () => NOW, screenshotsDir });
  const inject = (options: InjectOptions) => app.inject({ ...options, headers: { ...HOST, ...options.headers } });
  return {
    app,
    db: t.db,
    screenshotsDir,
    get: (url, headers = {}) => inject({ method: "GET", url, headers }),
    send: (method, url, body) =>
      body === undefined ? inject({ method, url }) : inject({ method, url, headers: { "content-type": "application/json" }, payload: JSON.stringify(body) }),
    close: async () => {
      await app.close();
      t.close();
    },
  };
}
