import { describe, expect, it } from "vitest";
import type { BackupOutcome } from "../ops/backup";
import type { KeepAwake } from "../ops/keepAwake";
import type { LogFields, Logger } from "../ops/log";
import type { SessionCheck, SessionCheckOutcome, StoredSession } from "../server/sessionStore";
import { BACKUP_EVERY_MS, KEEP_AWAKE_EVERY_MS, logSessionChanges, startOperations, type Timers } from "./operations";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Timers the test fires by hand. */
function manualTimers(): Timers & { fire(ms: number): void; active(): number } {
  const jobs: { ms: number; run: () => void; cancelled: boolean }[] = [];
  return {
    every(ms, run) {
      const job = { ms, run, cancelled: false };
      jobs.push(job);
      return () => {
        job.cancelled = true;
      };
    },
    fire(ms) {
      for (const job of jobs) if (!job.cancelled && job.ms === ms) job.run();
    },
    active: () => jobs.filter((job) => !job.cancelled).length,
  };
}

function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const write = (level: string) => (message: string, fields?: LogFields) => {
    lines.push(`${level} ${message}${fields === undefined ? "" : ` ${JSON.stringify(fields)}`}`);
  };
  return { lines, info: write("INFO"), warn: write("WARN"), error: write("ERROR") };
}

function fakeKeepAwake(): KeepAwake & { readonly updates: boolean[]; stopped: boolean } {
  let holding = false;
  const fake = {
    updates: [] as boolean[],
    stopped: false,
    update({ wanted }: { readonly wanted: boolean }) {
      fake.updates.push(wanted);
      if (!fake.stopped) holding = wanted;
    },
    stop() {
      fake.stopped = true;
      holding = false;
    },
    holding: () => holding,
  };
  return fake;
}

const created: BackupOutcome = { kind: "created", file: "/data/backups/app-2026-11-16.db", bytes: 4096, removed: [] };
const skipped: BackupOutcome = { kind: "skipped", file: "/data/backups/app-2026-11-16.db" };
const backupLines = (lines: readonly string[]) => lines.filter((line) => line.includes(" backup "));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(overrides: { engine?: "on" | "off"; backup?: () => Promise<BackupOutcome>; wanted?: () => boolean } = {}) {
  const timers = manualTimers();
  const log = recordingLogger();
  const keepAwake = fakeKeepAwake();
  let keepAwakesMade = 0;
  let backups = 0;
  const ops = startOperations({
    engine: overrides.engine ?? "on",
    backupIfDue: () => {
      backups += 1;
      return (overrides.backup ?? (async () => skipped))();
    },
    keepAwake: () => {
      keepAwakesMade += 1;
      return keepAwake;
    },
    keepAwakeWanted: overrides.wanted ?? (() => true),
    log,
    timers,
  });
  return { ops, timers, log, keepAwake, backups: () => backups, keepAwakesMade: () => keepAwakesMade };
}

describe("startOperations: backups", () => {
  it("backs up once at start and then every hour", async () => {
    const s = setup();
    expect(s.backups()).toBe(1);

    s.timers.fire(KEEP_AWAKE_EVERY_MS);
    await settle();
    expect(s.backups()).toBe(1);

    s.timers.fire(BACKUP_EVERY_MS);
    await settle();
    expect(BACKUP_EVERY_MS).toBe(HOUR);
    expect(s.backups()).toBe(2);
    await s.ops.stop();
  });

  it("logs a backup it made by file name only, and stays quiet about a skip", async () => {
    let next: BackupOutcome = created;
    const s = setup({ backup: async () => next });
    await settle();
    next = skipped;
    s.timers.fire(BACKUP_EVERY_MS);
    await settle();

    expect(backupLines(s.log.lines)).toEqual(['INFO backup created {"file":"app-2026-11-16.db","bytes":4096}']);
    await s.ops.stop();
  });

  it("logs a failed backup and carries on, whether it failed or threw", async () => {
    let calls = 0;
    const s = setup({
      backup: async () => {
        calls += 1;
        if (calls === 1) return { kind: "failed", error: "disk full" };
        throw new Error("database is closed");
      },
    });
    await settle();
    s.timers.fire(BACKUP_EVERY_MS);
    await settle();

    expect(backupLines(s.log.lines)).toEqual(['ERROR backup failed {"error":"disk full"}', 'ERROR backup failed {"error":"database is closed"}']);
    await s.ops.stop();
  });

  it("does not start a second backup while one is still running", async () => {
    let release: (outcome: BackupOutcome) => void = () => undefined;
    const s = setup({ backup: () => new Promise((resolve) => (release = resolve)) });
    s.timers.fire(BACKUP_EVERY_MS);
    expect(s.backups()).toBe(1);
    release(skipped);
    await s.ops.stop();
  });

  it("waits for a backup in flight before it says it has stopped", async () => {
    let release: (outcome: BackupOutcome) => void = () => undefined;
    const s = setup({ backup: () => new Promise((resolve) => (release = resolve)) });

    let stopped = false;
    const stopping = s.ops.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);

    release(created);
    await stopping;
    expect(stopped).toBe(true);
    expect(s.timers.active()).toBe(0);
  });
});

describe("startOperations: keep-awake", () => {
  it("updates keep-awake at start and every minute, and stops it at shutdown", async () => {
    const wanted = [true, true, false];
    const s = setup({ wanted: () => wanted.shift() ?? false });
    expect(s.keepAwake.updates).toEqual([true]);
    expect(s.ops.keepAwakeActive()).toBe(true);

    s.timers.fire(KEEP_AWAKE_EVERY_MS);
    s.timers.fire(KEEP_AWAKE_EVERY_MS);
    expect(KEEP_AWAKE_EVERY_MS).toBe(MINUTE);
    expect(s.keepAwake.updates).toEqual([true, true, false]);
    expect(s.ops.keepAwakeActive()).toBe(false);

    await s.ops.stop();
    expect(s.keepAwake.stopped).toBe(true);
    expect(s.timers.active()).toBe(0);
    expect(s.log.lines).toEqual(['INFO keep-awake {"wanted":true}', 'INFO keep-awake {"wanted":false}']);
  });

  it("starts no keep-awake with the engine off (no caffeinate in browser tests), but still backs up", async () => {
    const s = setup({ engine: "off" });
    s.timers.fire(KEEP_AWAKE_EVERY_MS);

    expect(s.keepAwakesMade()).toBe(0);
    expect(s.keepAwake.updates).toEqual([]);
    expect(s.ops.keepAwakeActive()).toBe(false);
    expect(s.backups()).toBe(1);
    await s.ops.stop();
  });

  it("logs a failed decision and keeps the minute timer going", async () => {
    let calls = 0;
    const s = setup({
      wanted: () => {
        calls += 1;
        if (calls === 2) throw new Error("database is locked");
        return true;
      },
    });
    s.timers.fire(KEEP_AWAKE_EVERY_MS);
    s.timers.fire(KEEP_AWAKE_EVERY_MS);

    expect(s.keepAwake.updates).toEqual([true, true]);
    expect(s.log.lines).toContain('ERROR keep-awake check failed {"error":"database is locked"}');
    await s.ops.stop();
  });
});

describe("logSessionChanges", () => {
  const session = (status: StoredSession["status"]): StoredSession => ({ status, lastCheckedAt: null, lastError: null, screenshotPath: null });

  function fakeCheck(outcomes: SessionCheckOutcome[]): SessionCheck {
    return { run: async () => outcomes.shift() ?? { kind: "busy" }, running: false, close: async () => undefined };
  }

  it("logs a change of session state and a failed check, and nothing when the state stands", async () => {
    const log = recordingLogger();
    let stored: StoredSession["status"] = "unknown";
    const check = logSessionChanges(
      fakeCheck([
        { kind: "checked", session: session("ok") },
        { kind: "checked", session: session("ok") },
        { kind: "failed", session: session("ok"), error: "window closed" },
      ]),
      {
        readStatus: () => stored,
        log,
      },
    );

    await check.run();
    stored = "ok";
    await check.run();
    await check.run();
    await check.run();

    expect(log.lines).toEqual(['INFO session changed {"from":"unknown","to":"ok"}', 'WARN session check failed {"error":"window closed"}']);
  });
});
