/**
 * Human pacing between actions (spec section 6, "Pacing"): a random gap after each action, and a
 * longer break instead after every N actions. Held in memory; a new engine sets its gate on its
 * first tick (see `Pacer.start`), so a restart never acts right after the last action.
 *
 * Known limit, accepted: a restart drops a long break that was scheduled (the new gate is one
 * ordinary gap) and resets the count of actions until the next break. A restart is itself a pause,
 * so this is not worth persisting.
 */
import { max } from "drizzle-orm";
import type { Settings } from "../config/settings";
import { actions } from "../db/schema";
import { randomInt } from "../linkedin/human";
import type { Conn } from "./ledger";
import type { RandomSource } from "./ports";

export interface FirstTick {
  readonly now: Date;
  /** True when the tick found a ledger row left in progress by a run that stopped. */
  readonly foundInProgress: boolean;
}

export interface Pacer {
  /**
   * Sets the gate a new engine starts from; only the first call counts, later ones do nothing.
   * When the first tick found a row left in progress, the gate is that tick's `now` plus one gap:
   * the row has no finish time, and LinkedIn may have loaded its page well after it started.
   * Otherwise it is the newest started or finished time in the ledger plus one gap, or none on an
   * empty ledger.
   */
  start(db: Conn, settings: Settings, tick: FirstTick): void;
  /** No action may start before this instant. Null when nothing has happened yet. */
  notBefore(): Date | null;
  /** Records an action that ended at `at` and returns the new gate. */
  afterAction(settings: Settings, at: Date): Date;
}

function gapMs(settings: Settings, random: RandomSource): number {
  const { min, max: most } = settings.actionGapSeconds;
  return randomInt({ min, max: most, random }) * 1000;
}

/** The newest started or finished time in the ledger. */
function lastLedgerTime(db: Conn): Date | null {
  const row = db.select({ started: max(actions.startedAt), finished: max(actions.finishedAt) }).from(actions).get();
  const times = [row?.started, row?.finished].filter((t): t is Date => t instanceof Date);
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

export function createPacer(random: RandomSource): Pacer {
  let gate: Date | null | undefined;
  let untilBreak: number | undefined;

  const drawBreakCount = (settings: Settings): number =>
    randomInt({ min: settings.breaks.everyActionsMin, max: settings.breaks.everyActionsMax, random });

  return {
    start(db, settings, tick) {
      if (gate !== undefined) return;
      const from = tick.foundInProgress ? tick.now : lastLedgerTime(db);
      gate = from === null ? null : new Date(from.getTime() + gapMs(settings, random));
    },

    notBefore() {
      return gate ?? null;
    },

    afterAction(settings, at) {
      untilBreak = (untilBreak ?? drawBreakCount(settings)) - 1;
      let pause: number;
      if (untilBreak <= 0) {
        const { minutesMin, minutesMax } = settings.breaks;
        pause = randomInt({ min: minutesMin, max: minutesMax, random }) * 60_000;
        untilBreak = drawBreakCount(settings);
      } else {
        pause = gapMs(settings, random);
      }
      gate = new Date(at.getTime() + pause);
      return gate;
    },
  };
}
