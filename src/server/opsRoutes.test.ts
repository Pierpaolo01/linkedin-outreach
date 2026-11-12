import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAi } from "../ai/fakeAi";
import type { Ai } from "../ai/types";
import { AiUnavailable } from "../ai/types";
import { openTestDb, type TestDb } from "../campaigns/testSeed";
import { setSettings } from "../config/settings";
import type { BackupOutcome } from "../ops/backup";
import type { ServiceStatus } from "../ops/service";
import { buildServer } from "./app";
import type { OpsDeps } from "./opsRoutes";
import { createFakeSessionPort } from "./sessionPort";
import { createSessionCheck } from "./sessionStore";

const PORT = 4747;
const HOST = { host: `127.0.0.1:${PORT}` } as const;
const NOW = new Date("2026-11-16T09:00:00Z");

let t: TestDb;
let root: string;
let app: FastifyInstance;

const NOT_INSTALLED: ServiceStatus = { installed: false, loaded: false, pid: null, lastExit: null };

/** A monotonic clock that moves `step` ms each time it is read. */
function steppingClock(step: number): () => number {
  let at = 0;
  return () => {
    at += step;
    return at;
  };
}

function start(overrides: Partial<OpsDeps> = {}): FastifyInstance {
  const uiDir = join(t.dir, "ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html>");
  const session = createSessionCheck({ db: t.db, port: createFakeSessionPort(["ok"]), now: () => NOW });
  const ops: OpsDeps = {
    paths: { root, backups: join(root, "backups") },
    backupNow: async () => ({ kind: "created", file: join(root, "backups", "app-2026-11-16.db"), bytes: 4096, removed: [] }),
    serviceStatus: () => NOT_INSTALLED,
    repoDir: "/Users/someone/code/linkedin-outreach",
    home: "/Users/someone",
    keepAwakeActive: () => false,
    createAi: () => createFakeAi(),
    monotonic: steppingClock(250),
    ...overrides,
  };
  app = buildServer({ db: t.db, session, uiDir, port: PORT, now: () => NOW, ops });
  return app;
}

const get = (url: string) => app.inject({ method: "GET", url, headers: HOST });
const post = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, headers: { ...HOST, ...headers } });

beforeEach(() => {
  t = openTestDb();
  root = mkdtempSync(join(tmpdir(), "lo-ops-"));
});

afterEach(async () => {
  await app.close();
  t.close();
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/ops", () => {
  it("lists the backups newest first, the auto-start state, keep-awake and the data folder", async () => {
    mkdirSync(join(root, "backups"));
    writeFileSync(join(root, "backups", "app-2026-11-14.db"), "x".repeat(10));
    writeFileSync(join(root, "backups", "app-2026-11-15.db"), "x".repeat(20));
    writeFileSync(join(root, "backups", "notes.txt"), "not a backup");
    start({
      serviceStatus: () => ({ installed: true, loaded: true, pid: 812, lastExit: null }),
      keepAwakeActive: () => true,
    });

    const res = await get("/api/ops");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      backups: [
        { file: "app-2026-11-15.db", date: "2026-11-15", sizeBytes: 20 },
        { file: "app-2026-11-14.db", date: "2026-11-14", sizeBytes: 10 },
      ],
      service: { installed: true, loaded: true, running: true, note: null },
      keepAwake: { enabled: true, active: true },
      dataDir: root,
    });
  });

  it("explains why auto-start cannot be installed from a folder macOS protects", async () => {
    start({ repoDir: "/Users/someone/Documents/linkedin-outreach" });

    const res = await get("/api/ops");

    expect(res.json()).toMatchObject({
      backups: [],
      service: { installed: false, loaded: false, running: false },
    });
    expect(res.json().service.note).toMatch(/~\/Documents/);
    expect(res.json().service.note).toMatch(/move|clone/i);
  });

  it("says how to turn auto-start on when it is not installed", async () => {
    start();

    const res = await get("/api/ops");

    expect(res.json().service.note).toContain("npm run service:install");
  });

  it("reports keep-awake turned off in Settings", async () => {
    setSettings(t.db, { keepAwake: false }, NOW);
    start();

    const res = await get("/api/ops");

    expect(res.json().keepAwake).toEqual({ enabled: false, active: false });
  });

  it("still answers when launchctl cannot be asked, with the reason in the note", async () => {
    start({
      serviceStatus: () => {
        throw new Error("spawnSync launchctl ENOENT");
      },
    });

    const res = await get("/api/ops");

    expect(res.statusCode).toBe(200);
    expect(res.json().service).toEqual({
      installed: false,
      loaded: false,
      running: false,
      note: "Could not read the auto-start state (spawnSync launchctl ENOENT).",
    });
  });
});

describe("POST /api/ops/backup", () => {
  it("makes a backup now and names the file", async () => {
    let calls = 0;
    start({
      backupNow: async () => {
        calls += 1;
        return { kind: "created", file: join(root, "backups", "app-2026-11-16.db"), bytes: 4096, removed: [] };
      },
    });

    const res = await post("/api/ops/backup");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: "created", file: "app-2026-11-16.db" });
    expect(calls).toBe(1);
  });

  it("answers a failed backup with what went wrong", async () => {
    start({ backupNow: async (): Promise<BackupOutcome> => ({ kind: "failed", error: "the copy failed its integrity check: page 3 is damaged" }) });

    const res = await post("/api/ops/backup");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: "failed", message: "The backup failed: the copy failed its integrity check: page 3 is damaged" });
  });

  it("answers a backup that threw as failed too", async () => {
    start({
      backupNow: async () => {
        throw new Error("disk full");
      },
    });

    const res = await post("/api/ops/backup");

    expect(res.json()).toEqual({ kind: "failed", message: "The backup failed: disk full" });
  });

  it("takes no body", async () => {
    start();

    const res = await app.inject({
      method: "POST",
      url: "/api/ops/backup",
      headers: { ...HOST, "content-type": "application/json" },
      payload: JSON.stringify({ force: true }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "This endpoint takes no body" });
  });
});

describe("POST /api/ai/test", () => {
  it("runs the self-test with the provider in Settings and says how long it took", async () => {
    setSettings(t.db, { ai: { provider: "anthropic_api", model: "claude-opus-5-5" } }, NOW);
    const asked: unknown[] = [];
    start({
      createAi: (settings) => {
        asked.push(settings);
        return createFakeAi();
      },
    });

    const res = await post("/api/ai/test");

    expect(res.statusCode).toBe(200);
    expect(asked).toEqual([{ provider: "anthropic_api", model: "claude-opus-5-5" }]);
    expect(res.json()).toEqual({
      ok: true,
      provider: "anthropic_api",
      model: "fake",
      elapsedMs: 250,
      message: expect.stringContaining("Marco"),
    });
  });

  it("turns an AI that cannot be reached into ok: false with a message the user can act on", async () => {
    const unreachable: Ai = {
      ...createFakeAi(),
      cleanVariables: async () => {
        throw new AiUnavailable('The claude CLI was not found ("claude"). Install Claude Code and log in, or choose the Anthropic API in Settings.');
      },
    };
    start({ createAi: () => unreachable });

    const res = await post("/api/ai/test");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: false,
      provider: "claude_cli",
      model: null,
      elapsedMs: 250,
      message: 'The claude CLI was not found ("claude"). Install Claude Code and log in, or choose the Anthropic API in Settings.',
    });
  });

  it("adds what to check when the AI's own error does not say", async () => {
    start({
      createAi: () => {
        throw new Error("boom");
      },
    });

    const res = await post("/api/ai/test");

    expect(res.json()).toMatchObject({ ok: false, provider: "claude_cli", model: null });
    expect(res.json().message).toMatch(/^The AI test failed: boom\. /);
    expect(res.json().message).toContain("claude");
  });

  it("refuses a second test while one runs", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Ai = {
      ...createFakeAi(),
      cleanVariables: async (input) => {
        await held;
        return createFakeAi().cleanVariables(input);
      },
    };
    start({ createAi: () => slow });

    const first = post("/api/ai/test");
    await new Promise((resolve) => setImmediate(resolve));
    const second = await post("/api/ai/test");
    release();

    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "An AI test is already running" });
    expect((await first).json()).toMatchObject({ ok: true });
    expect((await post("/api/ai/test")).statusCode).toBe(200);
  });
});

describe("Host and Origin checks on the operations routes", () => {
  it("refuses GET /api/ops from another host", async () => {
    start();

    const res = await app.inject({ method: "GET", url: "/api/ops", headers: { host: "evil.example" } });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Forbidden host" });
  });

  it("refuses POST /api/ops/backup from another origin and makes no backup", async () => {
    let calls = 0;
    start({
      backupNow: async () => {
        calls += 1;
        return { kind: "skipped", file: "x" };
      },
    });

    const res = await post("/api/ops/backup", { origin: "http://evil.example" });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Forbidden origin" });
    expect(calls).toBe(0);
  });
});
