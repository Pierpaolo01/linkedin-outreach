import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSettings, type Settings } from "../config/settings";
import { actions } from "../db/schema";
import { createPacer } from "./pacing";
import { createKit, MINUTE, type Kit } from "./testKit";

let kit: Kit;
let settings: Settings;
beforeEach(() => {
  kit = createKit();
  kit.settings({ actionGapSeconds: { min: 45, max: 180 }, breaks: { everyActionsMin: 3, everyActionsMax: 3, minutesMin: 10, minutesMax: 30 } });
  settings = getSettings(kit.db);
});
afterEach(() => kit.close());

const at = (ms: number) => new Date(Date.UTC(2026, 10, 16, 9) + ms);

/** A pacer started as on an engine's first tick. */
function started(random: () => number, tick: { now: Date; foundInProgress: boolean } = { now: at(60_000), foundInProgress: false }) {
  const pacer = createPacer(random);
  pacer.start(kit.db, settings, tick);
  return pacer;
}

describe("pacing gate", () => {
  it("has no gate with an empty ledger", () => {
    expect(started(() => 0.5).notBefore()).toBeNull();
  });

  it("after a restart starts from the newest started or finished time in the ledger plus one gap", () => {
    kit.db
      .insert(actions)
      .values([
        { type: "profile_view", status: "done", idempotencyKey: "a", startedAt: at(0), finishedAt: at(10_000) },
        { type: "invite", status: "unknown", idempotencyKey: "b", startedAt: at(20_000), finishedAt: null },
      ])
      .run();
    expect(started(() => 0).notBefore()).toEqual(at(20_000 + 45_000));
    expect(started(() => 0.999_999).notBefore()).toEqual(at(20_000 + 180_000));
  });

  it("after a restart that found a row left in progress starts from that first tick plus one gap", () => {
    kit.db.insert(actions).values({ type: "invite", status: "unknown", idempotencyKey: "b", startedAt: at(20_000), finishedAt: null }).run();
    const tick = { now: at(30_000), foundInProgress: true };
    expect(started(() => 0, tick).notBefore()).toEqual(at(30_000 + 45_000));
    expect(started(() => 0.999_999, tick).notBefore()).toEqual(at(30_000 + 180_000));
  });

  it("only the first start counts", () => {
    const pacer = started(() => 0, { now: at(0), foundInProgress: true });
    pacer.start(kit.db, settings, { now: at(600_000), foundInProgress: true });
    expect(pacer.notBefore()).toEqual(at(45_000));
  });

  it("puts a random gap in actionGapSeconds after each action", () => {
    const low = started(() => 0);
    expect(low.afterAction(settings, at(0))).toEqual(at(45_000));
    expect(low.notBefore()).toEqual(at(45_000));
    const high = createPacer(() => 0.999_999);
    expect(high.afterAction(settings, at(0))).toEqual(at(180_000));
  });

  describe("after a restart, the count of actions until the next break comes from the ledger", () => {
    // Settings: a gap of 45–180 s, a break of 10–30 minutes after every 3 actions.
    let key = 0;
    /** One piece of work: a profile view, then a step 5 s later, 10 s each. */
    function piece(startMs: number) {
      for (const [type, offset] of [
        ["profile_view", 0],
        ["invite", 10_000],
      ] as const) {
        key += 1;
        kit.db.insert(actions).values({ type, status: "done", idempotencyKey: `piece:${key}`, startedAt: at(startMs + offset), finishedAt: at(startMs + offset + 10_000) }).run();
      }
    }
    const MIN = 60_000;
    const newest = (startMs: number) => startMs + 20_000;

    it("three pieces since the ledger began: the first gate is a break from the newest ledger time", () => {
      [0, 2 * MIN, 4 * MIN].forEach(piece);
      const tick = { now: at(4 * MIN + 30_000), foundInProgress: false };
      expect(started(() => 0, tick).notBefore()).toEqual(at(newest(4 * MIN) + 10 * MINUTE));
      expect(started(() => 0.999_999, tick).notBefore()).toEqual(at(newest(4 * MIN) + 30 * MINUTE));
    });

    it("three pieces since the last pause of 10 minutes or more, after many before it: a break", () => {
      [0, 2 * MIN, 4 * MIN, 6 * MIN].forEach(piece);
      [20 * MIN, 22 * MIN, 24 * MIN].forEach(piece);
      expect(started(() => 0, { now: at(25 * MIN), foundInProgress: false }).notBefore()).toEqual(at(newest(24 * MIN) + 10 * MINUTE));
    });

    it("two pieces since the last pause: an ordinary gap first, then the break after the next action", () => {
      [0, 2 * MIN, 4 * MIN, 6 * MIN].forEach(piece);
      [20 * MIN, 22 * MIN].forEach(piece);
      const pacer = started(() => 0, { now: at(23 * MIN), foundInProgress: false });
      expect(pacer.notBefore()).toEqual(at(newest(22 * MIN) + 45_000));
      expect(pacer.afterAction(settings, at(24 * MIN))).toEqual(at(24 * MIN + 10 * MINUTE));
      expect(pacer.afterAction(settings, at(40 * MIN))).toEqual(at(40 * MIN + 45_000));
    });

    it("rows less than actionGapSeconds.min apart are one piece of work", () => {
      // Three reads 20 s apart (under 45 s): one piece. With one more piece, two in all: no break yet.
      [0, 30_000, 60_000].forEach(piece);
      piece(4 * MIN);
      expect(started(() => 0, { now: at(5 * MIN), foundInProgress: false }).notBefore()).toEqual(at(newest(4 * MIN) + 45_000));
    });

    it("downtime of 10 minutes or more before the restart is itself the pause", () => {
      [0, 2 * MIN, 4 * MIN].forEach(piece);
      const pacer = started(() => 0, { now: at(60 * MIN), foundInProgress: false });
      expect(pacer.notBefore()).toEqual(at(newest(4 * MIN) + 45_000));
      expect(pacer.afterAction(settings, at(61 * MIN))).toEqual(at(61 * MIN + 45_000));
    });

    it("a row left in progress: the downtime is not trusted as a pause, and the break runs from the restart", () => {
      [0, 2 * MIN, 4 * MIN].forEach(piece);
      expect(started(() => 0, { now: at(60 * MIN), foundInProgress: true }).notBefore()).toEqual(at(60 * MIN + 10 * MINUTE));
    });
  });

  it("takes a break of breaks.minutes instead of the gap after every N actions", () => {
    const pacer = createPacer(() => 0);
    const gaps = [1, 2, 3, 4, 5, 6].map((n) => pacer.afterAction(settings, at(n * 3_600_000)).getTime() - at(n * 3_600_000).getTime());
    expect(gaps).toEqual([45_000, 45_000, 10 * MINUTE, 45_000, 45_000, 10 * MINUTE]);
  });
});
