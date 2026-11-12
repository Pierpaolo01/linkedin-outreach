import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type OpenedDb } from "../db/index";
import { eventLog } from "../db/schema";
import { createFakeSessionPort, type SessionPort } from "./sessionPort";
import { setSettings } from "../config/settings";
import { createSessionCheck, readSession, runStartupCheck } from "./sessionStore";

let dir: string;
let opened: OpenedDb;
const at = new Date("2026-11-11T09:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-session-store-"));
  opened = openDb(join(dir, "app.db"));
});

afterEach(() => {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

function events(): string[] {
  return opened.db
    .select()
    .from(eventLog)
    .all()
    .map((row) => `${row.level}: ${row.message}`);
}

describe("readSession", () => {
  it("reads a missing row as unknown and never checked", () => {
    expect(readSession(opened.db)).toEqual({ status: "unknown", lastCheckedAt: null, lastError: null, screenshotPath: null });
  });
});

describe("createSessionCheck", () => {
  it("stores the observed state with the time of the check", async () => {
    const check = createSessionCheck({ db: opened.db, port: createFakeSessionPort(["ok"]), now: () => at });

    const outcome = await check.run();

    expect(outcome).toEqual({
      kind: "checked",
      session: { status: "ok", lastCheckedAt: at, lastError: null, screenshotPath: null },
    });
    expect(readSession(opened.db)).toEqual(outcome.kind === "checked" ? outcome.session : undefined);
  });

  it("keeps the evidence of a state that is not ok", async () => {
    const port: SessionPort = {
      check: async () => ({ state: "checkpoint", evidence: "url path /checkpoint/challenge", screenshotPath: "/s/1.png" }),
      close: async () => undefined,
    };
    await createSessionCheck({ db: opened.db, port, now: () => at }).run();

    expect(readSession(opened.db)).toEqual({
      status: "checkpoint",
      lastCheckedAt: at,
      lastError: "url path /checkpoint/challenge",
      screenshotPath: "/s/1.png",
    });
  });

  it("logs a line each time the status changes, and nothing when it stays the same", async () => {
    const check = createSessionCheck({
      db: opened.db,
      port: createFakeSessionPort(["logged_out", "logged_out", "ok", "checkpoint"]),
      now: () => at,
    });
    for (let i = 0; i < 4; i += 1) await check.run();

    expect(events()).toEqual([
      "warning: LinkedIn session: logged_out",
      "info: LinkedIn session: ok",
      "error: LinkedIn session: checkpoint",
    ]);
  });

  it("logs nothing when a first check finds the classifier's unknown", async () => {
    await createSessionCheck({ db: opened.db, port: createFakeSessionPort(["unknown"]), now: () => at }).run();

    expect(readSession(opened.db).status).toBe("unknown");
    expect(readSession(opened.db).lastCheckedAt).toEqual(at);
    expect(events()).toEqual([]);
  });

  it("stores a failed check as an error and keeps the last observed status", async () => {
    const states = createFakeSessionPort(["restricted"]);
    let fail = false;
    const port: SessionPort = {
      check: async () => {
        if (fail) throw new Error("Could not open the dedicated window");
        return states.check();
      },
      close: async () => undefined,
    };
    const check = createSessionCheck({ db: opened.db, port, now: () => at });
    await check.run();
    fail = true;

    const outcome = await check.run();

    expect(outcome).toEqual({
      kind: "failed",
      error: "Could not open the dedicated window",
      session: { status: "restricted", lastCheckedAt: at, lastError: "Could not open the dedicated window", screenshotPath: null },
    });
    expect(events()).toEqual([
      "error: LinkedIn session: restricted",
      "warning: LinkedIn session check failed: Could not open the dedicated window",
    ]);
  });

  it("refuses a second check while one is running", async () => {
    let release: () => void = () => undefined;
    const port: SessionPort = {
      check: () =>
        new Promise((resolve) => {
          release = () => resolve({ state: "ok", evidence: "fake" });
        }),
      close: async () => undefined,
    };
    const check = createSessionCheck({ db: opened.db, port, now: () => at });

    const first = check.run();
    expect(check.running).toBe(true);
    expect(await check.run()).toEqual({ kind: "busy" });
    release();
    expect((await first).kind).toBe("checked");
    expect(check.running).toBe(false);
  });

  it("survives a restart: the stored state is read back from a reopened database", async () => {
    await createSessionCheck({ db: opened.db, port: createFakeSessionPort(["logged_out"]), now: () => at }).run();
    opened.close();
    opened = openDb(join(dir, "app.db"));

    expect(readSession(opened.db)).toMatchObject({ status: "logged_out", lastCheckedAt: at });
  });
});

describe("runStartupCheck", () => {
  /** A port that counts its checks: each one would load LinkedIn's feed. */
  function countingPort(): SessionPort & { loads: number } {
    const states = createFakeSessionPort(["ok"]);
    const port = {
      loads: 0,
      check: async () => {
        port.loads += 1;
        return states.check();
      },
      close: async () => undefined,
    };
    return port;
  }

  it("checks the session inside the working window", async () => {
    const port = countingPort();
    const session = createSessionCheck({ db: opened.db, port, now: () => at });

    const outcome = await runStartupCheck({ db: opened.db, session, now: () => at, onlyInWorkingWindow: true });

    expect(outcome.kind).toBe("checked");
    expect(port.loads).toBe(1);
  });

  it("loads nothing outside the working window and leaves the stored state as it was", async () => {
    const port = countingPort();
    const session = createSessionCheck({ db: opened.db, port: createFakeSessionPort(["logged_out"]), now: () => at });
    await session.run();
    const night = new Date("2026-11-11T22:00:00Z");
    const atNight = createSessionCheck({ db: opened.db, port, now: () => night });

    const outcome = await runStartupCheck({ db: opened.db, session: atNight, now: () => night, onlyInWorkingWindow: true });

    expect(outcome).toEqual({ kind: "outside_working_window", session: readSession(opened.db) });
    expect(port.loads).toBe(0);
    expect(readSession(opened.db)).toMatchObject({ status: "logged_out", lastCheckedAt: at });
  });

  it("follows the working window from the settings", async () => {
    const port = countingPort();
    const night = new Date("2026-11-11T22:00:00Z");
    setSettings(opened.db, { workingHours: { start: "08:00", end: "23:30" } }, at);
    const session = createSessionCheck({ db: opened.db, port, now: () => night });

    await runStartupCheck({ db: opened.db, session, now: () => night, onlyInWorkingWindow: true });

    expect(port.loads).toBe(1);
  });

  it("checks at any hour when the port loads no LinkedIn page (the fake driver)", async () => {
    const port = countingPort();
    const night = new Date("2026-11-11T22:00:00Z");
    const session = createSessionCheck({ db: opened.db, port, now: () => night });

    await runStartupCheck({ db: opened.db, session, now: () => night, onlyInWorkingWindow: false });

    expect(port.loads).toBe(1);
  });
});
