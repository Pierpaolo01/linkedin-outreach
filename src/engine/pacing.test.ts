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

  it("takes a break of breaks.minutes instead of the gap after every N actions", () => {
    const pacer = createPacer(() => 0);
    const gaps = [1, 2, 3, 4, 5, 6].map((n) => pacer.afterAction(settings, at(n * 3_600_000)).getTime() - at(n * 3_600_000).getTime());
    expect(gaps).toEqual([45_000, 45_000, 10 * MINUTE, 45_000, 45_000, 10 * MINUTE]);
  });
});
