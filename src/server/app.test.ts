import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../config/settings";
import { openDb, type OpenedDb } from "../db/index";
import { buildServer } from "./app";
import { createFakeSessionPort, type SessionPort } from "./sessionPort";
import { createSessionCheck } from "./sessionStore";

const PORT = 4747;
const HOST = { host: `127.0.0.1:${PORT}` };
const at = new Date("2026-11-11T09:00:00.000Z");

let dir: string;
let opened: OpenedDb;
let uiDir: string;
let app: FastifyInstance;

function start(port: SessionPort = createFakeSessionPort(["logged_out", "ok"])): FastifyInstance {
  const session = createSessionCheck({ db: opened.db, port, now: () => at });
  app = buildServer({ db: opened.db, session, uiDir, port: PORT });
  return app;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-app-"));
  opened = openDb(join(dir, "app.db"));
  uiDir = join(dir, "ui");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>LinkedIn outreach</title>");
  writeFileSync(join(uiDir, "assets", "app.js"), "console.info('ui');");
});

afterEach(async () => {
  await app.close();
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/health", () => {
  it("reports the app version and a working database", async () => {
    const res = await start().inject({ method: "GET", url: "/api/health", headers: HOST });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: "0.1.0", dbOk: true });
  });

  it("reports a database it cannot read", async () => {
    const server = start();
    opened.close();

    const res = await server.inject({ method: "GET", url: "/api/health", headers: HOST });
    opened = openDb(join(dir, "app.db"));

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, dbOk: false });
  });
});

describe("Host header", () => {
  it.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`])("accepts %s", async (host) => {
    const res = await start().inject({ method: "GET", url: "/api/health", headers: { host } });

    expect(res.statusCode).toBe(200);
  });

  it.each(["evil.example", `evil.example:${PORT}`, "127.0.0.1:9999", "localhost", ""])(
    "refuses %j, so a page on another site cannot reach the app by DNS rebinding",
    async (host) => {
      const res = await start().inject({ method: "GET", url: "/api/health", headers: { host } });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "Forbidden host" });
    },
  );

  it("refuses a page request too, not only the API", async () => {
    const res = await start().inject({ method: "GET", url: "/", headers: { host: "evil.example" } });

    expect(res.statusCode).toBe(403);
  });

  it("refuses a write sent by a page on another origin", async () => {
    const res = await start().inject({
      method: "POST",
      url: "/api/session/check",
      headers: { ...HOST, origin: "http://evil.example" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Forbidden origin" });
  });

  it("accepts a write from the dashboard itself", async () => {
    const res = await start().inject({
      method: "POST",
      url: "/api/session/check",
      headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it("sends no CORS headers", async () => {
    const res = await start().inject({
      method: "GET",
      url: "/api/session",
      headers: { ...HOST, origin: "http://evil.example" },
    });

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("GET /api/session", () => {
  it("reads as unknown before any check", async () => {
    const res = await start().inject({ method: "GET", url: "/api/session", headers: HOST });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unknown", lastCheckedAt: null, lastError: null, checking: false });
  });
});

describe("POST /api/session/check", () => {
  it("checks now, stores the result and returns it", async () => {
    const server = start();

    const res = await server.inject({ method: "POST", url: "/api/session/check", headers: HOST });
    const after = await server.inject({ method: "GET", url: "/api/session", headers: HOST });

    const expected = { status: "logged_out", lastCheckedAt: at.toISOString(), lastError: "fake driver: logged_out", checking: false };
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expected);
    expect(after.json()).toEqual(expected);
  });

  it("returns 409 while a check is already running, and reports it as checking", async () => {
    let release: () => void = () => undefined;
    let checks = 0;
    const server = start({
      check: () =>
        new Promise((resolve) => {
          checks += 1;
          release = () => resolve({ state: "ok", evidence: "fake" });
        }),
      close: async () => undefined,
    });

    const first = server.inject({ method: "POST", url: "/api/session/check", headers: HOST });
    await new Promise((resolve) => setImmediate(resolve));
    const second = await server.inject({ method: "POST", url: "/api/session/check", headers: HOST });
    const during = await server.inject({ method: "GET", url: "/api/session", headers: HOST });
    release();

    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "A session check is already running" });
    expect(during.json()).toMatchObject({ checking: true });
    expect((await first).statusCode).toBe(200);
    expect(checks).toBe(1);
  });

  it("returns 502 with the stored error when the check fails", async () => {
    const server = start({
      check: async () => {
        throw new Error("Could not open the dedicated Chrome window: crashed");
      },
      close: async () => undefined,
    });

    const res = await server.inject({ method: "POST", url: "/api/session/check", headers: HOST });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "Could not open the dedicated Chrome window: crashed",
      session: {
        status: "unknown",
        lastCheckedAt: null,
        lastError: "Could not open the dedicated Chrome window: crashed",
        checking: false,
      },
    });
  });

  it("refuses a body it does not expect", async () => {
    const res = await start().inject({
      method: "POST",
      url: "/api/session/check",
      headers: { ...HOST, "content-type": "application/json" },
      payload: { state: "ok" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/settings", () => {
  it("returns the typed settings, defaults included", async () => {
    const res = await start().inject({ method: "GET", url: "/api/settings", headers: HOST });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("the dashboard", () => {
  it("serves the built UI at /", async () => {
    const res = await start().inject({ method: "GET", url: "/", headers: HOST });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("<title>LinkedIn outreach</title>");
  });

  it("serves the UI's assets", async () => {
    const res = await start().inject({ method: "GET", url: "/assets/app.js", headers: HOST });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.info('ui')");
  });

  it("falls back to index.html for any other page", async () => {
    const res = await start().inject({ method: "GET", url: "/campaigns/3", headers: HOST });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>LinkedIn outreach</title>");
  });

  it("answers an unknown API route with a JSON 404, not the UI", async () => {
    const res = await start().inject({ method: "GET", url: "/api/nope", headers: HOST });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found" });
  });

  it("answers a missing asset with a 404, not the UI", async () => {
    const res = await start().inject({ method: "GET", url: "/assets/missing.js", headers: HOST });

    expect(res.statusCode).toBe(404);
  });
});
