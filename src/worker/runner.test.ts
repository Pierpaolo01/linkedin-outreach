import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTestDb, type TestDb } from "../campaigns/testSeed";
import { getSettings, setSettings } from "../config/settings";
import { eventLog } from "../db/schema";
import type { Driver, Engine, EngineDeps, TickResult } from "../engine/ports";
import { systemClock } from "../engine/ports";
import { raiseSafetyStop, resumeSafetyStop } from "../engine/safetyStop";
import { createFakeAi } from "../ai/fakeAi";
import {
  actionRows,
  createKit,
  events,
  prospect,
  seedAccepted,
  seedApproved,
  seedCampaign,
  seedConnectionsChecked,
  seedInvited,
  START,
  stubAi,
  type Kit,
} from "../engine/testKit";
import { ProfileInUse } from "../linkedin/browser";
import type { LogFields, Logger } from "../ops/log";
import { readSession } from "../server/sessionStore";
import { readOnlyLinkedIn } from "./liveDriver";
import { startRunner, type Runner, type RunnerDeps } from "./runner";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** A driver no stub engine touches. */
const NO_DRIVER = {} as Driver;

interface StubEngine {
  /** Ticks started, by every engine built. */
  readonly ticks: Date[];
  /** Engines built, with the driver each was given. */
  readonly builds: EngineDeps[];
  /** The most ticks ever in flight at once. */
  maxInFlight: number;
  /** What the next tick does; default: resolves with wakeAt 10 s later. */
  next: (now: Date) => Promise<TickResult>;
}

function stubEngine(): StubEngine & { factory: (deps: EngineDeps) => Engine } {
  let inFlight = 0;
  const stub: StubEngine & { factory: (deps: EngineDeps) => Engine } = {
    ticks: [],
    builds: [],
    maxInFlight: 0,
    next: async (now) => ({ did: null, wakeAt: new Date(now.getTime() + 10 * SECOND) }),
    factory: (deps) => {
      stub.builds.push(deps);
      return {
        async tick() {
          const now = new Date();
          stub.ticks.push(now);
          inFlight += 1;
          stub.maxInFlight = Math.max(stub.maxInFlight, inFlight);
          try {
            return await stub.next(now);
          } finally {
            inFlight -= 1;
          }
        },
      };
    },
  };
  return stub;
}

/** Resolves after `ms` of fake time. */
const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A logger that keeps its lines, as `LEVEL message {fields}`. */
function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const write = (level: string) => (message: string, fields?: LogFields) => {
    lines.push(`${level} ${message}${fields === undefined ? "" : ` ${JSON.stringify(fields)}`}`);
  };
  return { lines, info: write("INFO"), warn: write("WARN"), error: write("ERROR") };
}

let t: TestDb;
let log: ReturnType<typeof recordingLogger>;
let runner: Runner | undefined;

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  t = openTestDb();
  log = recordingLogger();
});

afterEach(async () => {
  // A tick still in flight finishes on fake time.
  const stopped = runner?.stop();
  await vi.advanceTimersByTimeAsync(10 * MINUTE);
  await stopped;
  runner = undefined;
  vi.useRealTimers();
  t.close();
});

function start(stub: ReturnType<typeof stubEngine>, deps: Partial<RunnerDeps> = {}): Runner {
  runner = startRunner({
    db: t.db,
    clock: systemClock,
    random: () => 0.5,
    log,
    driver: () => NO_DRIVER,
    outreach: true,
    ai: () => createFakeAi(),
    engine: stub.factory,
    ...deps,
  });
  return runner;
}

const elapsed = (at: Date) => at.getTime() - START.getTime();

describe("the runner's timing", () => {
  it("ticks at once, then again at the engine's wakeAt", async () => {
    const stub = stubEngine();
    start(stub);
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.ticks.map(elapsed)).toEqual([0]);

    await vi.advanceTimersByTimeAsync(10 * SECOND - 1);
    expect(stub.ticks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.ticks.map(elapsed)).toEqual([0, 10 * SECOND]);
  });

  it("waits at most 30 seconds, so a change made in the dashboard is picked up within half a minute", async () => {
    const stub = stubEngine();
    stub.next = async (now) => ({ did: null, wakeAt: new Date(now.getTime() + 2 * 60 * MINUTE) });
    start(stub);

    await vi.advanceTimersByTimeAsync(95 * SECOND);
    expect(stub.ticks.map(elapsed)).toEqual([0, 30 * SECOND, 60 * SECOND, 90 * SECOND]);
  });

  it("never has two ticks in flight: a long tick delays the next one", async () => {
    const stub = stubEngine();
    stub.next = async (now) => {
      await later(3 * MINUTE);
      return { did: "slow", wakeAt: now };
    };
    start(stub);

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(stub.maxInFlight).toBe(1);
    expect(stub.ticks).toHaveLength(4);
    const gaps = stub.ticks.slice(1).map((at, i) => at.getTime() - (stub.ticks[i]?.getTime() ?? 0));
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(3 * MINUTE);
  });

  it("survives a rejecting tick: writes it to the event log and to the app's log, then waits a minute", async () => {
    const stub = stubEngine();
    let fail = true;
    stub.next = async (now) => {
      if (fail) {
        fail = false;
        throw new Error("database is locked\n    at somewhere");
      }
      return { did: null, wakeAt: new Date(now.getTime() + 10 * SECOND) };
    };
    start(stub);

    await vi.advanceTimersByTimeAsync(59 * SECOND);
    expect(stub.ticks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1 * SECOND);
    expect(stub.ticks.map(elapsed)).toEqual([0, 60 * SECOND]);

    const logged = t.db.select().from(eventLog).all();
    expect(logged).toEqual([
      expect.objectContaining({ level: "error", message: expect.stringContaining("database is locked at somewhere") }),
    ]);
    expect(log.lines).toEqual(['ERROR engine tick failed {"error":"database is locked at somewhere"}']);
  });

  it("builds a new driver and engine before the next tick once the user resumes a safety stop", async () => {
    const stub = stubEngine();
    let drivers = 0;
    start(stub, {
      driver: () => {
        drivers += 1;
        return NO_DRIVER;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect([drivers, stub.builds.length]).toEqual([1, 1]);

    raiseSafetyStop(t.db, { reason: "logged_out" }, new Date());
    await vi.advanceTimersByTimeAsync(20 * SECOND);
    expect([drivers, stub.builds.length]).toEqual([1, 1]);

    resumeSafetyStop(t.db, new Date());
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect([drivers, stub.builds.length]).toEqual([2, 2]);
    expect(stub.ticks).toHaveLength(4);
  });

  it("reads the AI at each build; when it cannot be created the engine runs without AI and one line says so", async () => {
    const stub = stubEngine();
    const said: string[] = [];
    start(stub, {
      ai: () => {
        throw new Error("no AI settings");
      },
      say: (line) => said.push(line),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(stub.builds[0]?.ai).toBeUndefined();
    expect(said.filter((line) => line.includes("without AI"))).toHaveLength(1);
    expect(t.db.select().from(eventLog).all()).toEqual([
      expect.objectContaining({ level: "warning", message: expect.stringContaining("no AI settings") }),
    ]);
  });
});

describe("a change of AI in Settings", () => {
  it("builds a new engine with the new AI before the next tick, and only when the AI setting changed", async () => {
    const stub = stubEngine();
    const built: string[] = [];
    const said: string[] = [];
    start(stub, {
      ai: () => {
        const { provider, model } = getSettings(t.db).ai;
        built.push(`${provider}/${model}`);
        return createFakeAi();
      },
      say: (line) => said.push(line),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.builds).toHaveLength(1);

    // Another setting changes: same engine.
    setSettings(t.db, { limits: { invitesPerDay: 3 } }, new Date());
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect(stub.builds).toHaveLength(1);

    setSettings(t.db, { ai: { provider: "anthropic_api", model: "claude-test" } }, new Date());
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect(stub.builds).toHaveLength(2);
    expect(built.at(-1)).toBe("anthropic_api/claude-test");
    expect(stub.ticks).toHaveLength(3);
    expect(said.filter((line) => line.includes("AI setting changed"))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(stub.builds).toHaveLength(2);
  });
});

describe("what the runner prints", () => {
  it("names the kind of work each tick did, and never the person", async () => {
    const stub = stubEngine();
    stub.next = async (now) => ({ did: "invite: Mario Rossi not confirmed", wakeAt: new Date(now.getTime() + 10 * SECOND) });
    const said: string[] = [];
    start(stub, { say: (line) => said.push(line) });
    await vi.advanceTimersByTimeAsync(0);

    expect(said).toEqual(["Engine: invite"]);
  });
});

describe("stopping the runner", () => {
  it("stops mid-wait at once, with no further tick", async () => {
    const stub = stubEngine();
    stub.next = async (now) => ({ did: null, wakeAt: new Date(now.getTime() + 25 * SECOND) });
    const running = start(stub);
    await vi.advanceTimersByTimeAsync(5 * SECOND);

    let stopped = false;
    void running.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(stub.ticks).toHaveLength(1);
  });

  it("stops mid-tick only once the tick in flight has finished", async () => {
    const stub = stubEngine();
    let finished = 0;
    stub.next = async (now) => {
      await later(10 * SECOND);
      finished += 1;
      return { did: "done", wakeAt: now };
    };
    const running = start(stub);
    await vi.advanceTimersByTimeAsync(4 * SECOND);

    let stopped = false;
    void running.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1 * SECOND);
    expect([stopped, finished]).toEqual([true, 1]);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(stub.ticks).toHaveLength(1);
  });

  it("writes nothing to the app's log when nothing failed", async () => {
    const stub = stubEngine();
    start(stub);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(log.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------- with the real engine and the fake LinkedIn

/** Records every driver operation called on `driver`, by name, into `calls`. */
function spied(driver: Driver, calls: string[]): Driver {
  const record =
    <A extends unknown[], R>(name: keyof Driver, op: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls.push(name);
      return op(...args);
    };
  return {
      ensureSession: record("ensureSession", () => driver.ensureSession()),
      searchPeople: record("searchPeople", (query) => driver.searchPeople(query)),
      listRecommendations: record("listRecommendations", () => driver.listRecommendations()),
      viewProfile: record("viewProfile", (publicId) => driver.viewProfile(publicId)),
      listRecentConnections: record("listRecentConnections", () => driver.listRecentConnections()),
      listSentInvitations: record("listSentInvitations", () => driver.listSentInvitations()),
      readThread: record("readThread", (person) => driver.readThread(person)),
      sendInvite: record("sendInvite", (person, note, guard) => driver.sendInvite(person, note, guard)),
      sendMessage: record("sendMessage", (person, text, expected) => driver.sendMessage(person, text, expected)),
      withdrawInvite: record("withdrawInvite", (person, guard) => driver.withdrawInvite(person, guard)),
  };
}

describe("the runner with the real engine", () => {
  let kit: Kit;
  beforeEach(() => {
    kit = createKit();
  });
  afterEach(async () => {
    const stopped = runner?.stop();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await stopped;
    runner = undefined;
    kit.close();
  });

  function startReal(deps: Partial<RunnerDeps> = {}): Runner {
    runner = startRunner({
      db: kit.db,
      clock: systemClock,
      random: kit.random,
      log,
      driver: () => kit.world.connect({ clock: systemClock, random: kit.random }).driver,
      outreach: true,
      ai: () => stubAi(),
      ...deps,
    });
    return runner;
  }

  it("works through due work on the fake LinkedIn, one tick at a time", async () => {
    const campaignId = seedCampaign(kit, { followUpDelayMinHours: 72, followUpDelayMaxHours: 72 });
    seedConnectionsChecked(kit);
    const accepted = seedAccepted(kit, campaignId);
    startReal();

    await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE);

    expect(kit.world.messagesSentTo(accepted.spec.publicId)).toHaveLength(1);
    expect(prospect(kit, accepted.prospectId).stage).toBe("message_sent");
    // A second tick while one was in flight would have closed the first one's row as interrupted.
    expect(actionRows(kit).filter((row) => row.errorKind === "interrupted")).toEqual([]);
  });

  // A whole simulated working day through the real engine: about 3 s alone, more on a busy CI runner.
  it("on the live site's terms never sends and never reads a thread, whatever is due", { timeout: 60_000 }, async () => {
    const campaignId = seedCampaign(kit);
    seedApproved(kit, campaignId);
    seedAccepted(kit, campaignId);
    seedInvited(kit, campaignId, 30);
    kit.world.addMember({ publicId: "recommended-1", memberId: "ACoARecommended1", fullName: "Rec One", headline: "Builder", degree: 2 });
    kit.world.setRecommendations([{ title: "People you may know", publicIds: ["recommended-1"] }]);
    // What the engine asks of the driver it is given, and what reaches the site underneath.
    const asked: string[] = [];
    const reached: string[] = [];
    const live = readOnlyLinkedIn(() => spied(kit.world.connect({ clock: systemClock, random: kit.random }).driver, reached));
    startReal({ outreach: live.outreach, driver: () => spied(live.driver(), asked) });

    await vi.advanceTimersByTimeAsync(8 * 60 * MINUTE);

    expect(reached).toContain("listRecommendations");
    const writesAndThreads = (ops: string[]) => ops.filter((op) => ["sendInvite", "sendMessage", "withdrawInvite", "readThread"].includes(op));
    expect(writesAndThreads(asked)).toEqual([]);
    expect(writesAndThreads(reached)).toEqual([]);
    expect(kit.world.log.filter((entry) => ["invite", "message", "withdraw", "thread_read"].includes(entry.kind))).toEqual([]);
  });

  it("the live driver's write operations refuse: sends are not in this build", async () => {
    const { driver, outreach } = readOnlyLinkedIn(() => kit.world.connect({ clock: systemClock, random: kit.random }).driver);
    const person = { publicId: "someone", memberId: "ACoASomeone" };
    const guard = { notAfter: new Date(START.getTime() + MINUTE) };

    expect(outreach).toBe(false);
    await expect(driver().sendInvite(person, null, guard)).rejects.toThrow(/not available in this build/);
    await expect(driver().sendMessage(person, "Hi", { ...guard, messageCount: 0 })).rejects.toThrow(/not available in this build/);
    await expect(driver().withdrawInvite(person, guard)).rejects.toThrow(/not available in this build/);
  });
});

// ---------------------------------------------------------------- the dedicated window

describe("the dedicated window", () => {
  let kit: Kit;
  beforeEach(() => {
    kit = createKit();
  });
  afterEach(async () => {
    const stopped = runner?.stop();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await stopped;
    runner = undefined;
    kit.close();
  });

  function startWithWindow(stub: ReturnType<typeof stubEngine>, window: () => Promise<void>): Runner {
    runner = startRunner({
      db: kit.db,
      clock: systemClock,
      random: kit.random,
      log,
      driver: () => NO_DRIVER,
      outreach: true,
      ai: () => stubAi(),
      window,
      engine: stub.factory,
    });
    return runner;
  }

  it("is not opened at start, nor while no LinkedIn work is due", async () => {
    const stub = stubEngine();
    let opened = 0;
    startWithWindow(stub, async () => {
      opened += 1;
    });

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(stub.ticks.length).toBeGreaterThan(1);
    expect(opened).toBe(0);
  });

  it("is not opened outside the working window, even with work due", async () => {
    vi.setSystemTime(new Date("2026-11-16T22:00:00Z"));
    const stub = stubEngine();
    seedApproved(kit, seedCampaign(kit));
    let opened = 0;
    startWithWindow(stub, async () => {
      opened += 1;
    });

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(stub.ticks.length).toBeGreaterThan(1);
    expect(opened).toBe(0);
  });

  it("is opened before the first tick that may load LinkedIn", async () => {
    const stub = stubEngine();
    let opened = 0;
    stub.next = async (now) => {
      expect(opened).toBeGreaterThan(0);
      return { did: null, wakeAt: new Date(now.getTime() + 10 * SECOND) };
    };
    seedApproved(kit, seedCampaign(kit));
    startWithWindow(stub, async () => {
      opened += 1;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect([opened, stub.ticks.length]).toEqual([1, 1]);
  });

  it("held by another process (ProfileInUse): no tick, shown in the session state once, tried again a minute later", async () => {
    const stub = stubEngine();
    seedApproved(kit, seedCampaign(kit));
    let inUse = true;
    let tries = 0;
    startWithWindow(stub, async () => {
      tries += 1;
      if (inUse) throw new ProfileInUse("/data/chrome-profile", { host: "mac", pid: 4242 });
    });

    await vi.advanceTimersByTimeAsync(2 * MINUTE + SECOND);
    expect(stub.ticks).toEqual([]);
    expect(tries).toBe(3);
    expect(readSession(kit.db).lastError).toMatch(/already open \(Chrome process 4242\)/);
    expect(events(kit).filter((line) => line.includes("Chrome process 4242"))).toHaveLength(1);

    inUse = false;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(stub.ticks).toHaveLength(1);
  });
});
