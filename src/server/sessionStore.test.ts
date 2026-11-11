import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type OpenedDb } from "../db/index";
import { eventLog } from "../db/schema";
import { createFakeSessionPort, type SessionPort } from "./sessionPort";
import { createSessionCheck, readSession } from "./sessionStore";

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
