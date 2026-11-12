/**
 * Human pacing between actions (spec section 6, "Pacing"): a random gap after each action, and a
 * longer break instead after every N actions. Held in memory, with no stored state of its own: a
 * new engine works out where it stands from the ledger on its first tick (see `Pacer.start`).
 *
 * A restart is not trusted as a break. The new engine counts the pieces of work the ledger shows
 * since the last pause of at least `breaks.minutesMin` minutes and carries on from that count, so
 * however often the process is killed and restarted there is never a run of more than
 * `breaks.everyActionsMax` pieces of work without such a pause. Replaces decision 52.
 */
import { desc, isNotNull, max } from "drizzle-orm";
import type { Settings } from "../config/settings";
import { actions } from "../db/schema";
import { randomInt } from "../linkedin/human";
import { stepOfKey, type Conn } from "./ledger";
import type { RandomSource } from "./ports";

export interface FirstTick {
  readonly now: Date;
  /** True when the tick found a ledger row left in progress by a run that stopped. */
  readonly foundInProgress: boolean;
}

export interface Pacer {
  /**
   * Sets the gate a new engine starts from; only the first call counts, later ones do nothing.
   * The gate runs from the newest started or finished time in the ledger, or, when the first tick
   * found a row left in progress, from that tick's `now`: the row has no finish time, and LinkedIn
   * may have loaded its page well after it started. It is one gap, or a break when the ledger
   * shows `breaks.everyActionsMax` pieces of work or more since the last pause. None on an empty
   * ledger.
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

function breakMs(settings: Settings, random: RandomSource): number {
  const { minutesMin, minutesMax } = settings.breaks;
  return randomInt({ min: minutesMin, max: minutesMax, random }) * 60_000;
}

/** The newest started or finished time in the ledger. */
function lastLedgerTime(db: Conn): Date | null {
  const row = db.select({ started: max(actions.startedAt), finished: max(actions.finishedAt) }).from(actions).get();
  const times = [row?.started, row?.finished].filter((t): t is Date => t instanceof Date);
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

const PAGE = 500;

/**
 * How many pieces of work the ledger shows since the last pause of at least `breaks.minutesMin`
 * minutes, counted up to `breaks.everyActionsMax` (more makes no difference). Rows less than
 * `actionGapSeconds.min` apart belong to one piece: every piece ends with a gate of at least that
 * gap, and the rows within one never have such a gap between them. A read's span runs from its
 * start to its finish. A step row counts at its claim time only: its finish time may be that of a
 * later reconcile, which would join two pieces into one. The ledger's beginning counts as a pause.
 */
function piecesSincePause(db: Conn, settings: Settings): number {
  const sameMs = settings.actionGapSeconds.min * 1000;
  const pauseMs = settings.breaks.minutesMin * 60_000;
  const enough = settings.breaks.everyActionsMax;
  let count = 0;
  /** The start of the oldest row of the piece being counted. */
  let pieceStart: number | null = null;
  for (let offset = 0; ; offset += PAGE) {
    const rows = db
      .select({ key: actions.idempotencyKey, startedAt: actions.startedAt, finishedAt: actions.finishedAt })
      .from(actions)
      .where(isNotNull(actions.startedAt))
      .orderBy(desc(actions.startedAt), desc(actions.id))
      .limit(PAGE)
      .offset(offset)
      .all();
    for (const row of rows) {
      if (row.startedAt === null) continue;
      const start = row.startedAt.getTime();
      const end = stepOfKey(row.key) === null ? Math.max(start, row.finishedAt?.getTime() ?? start) : start;
      if (pieceStart === null) {
        count = 1;
        pieceStart = start;
        continue;
      }
      const gap = pieceStart - end;
      if (gap >= pauseMs) return count;
      if (gap >= sameMs) {
        count += 1;
        if (count >= enough) return count;
      }
      pieceStart = Math.min(pieceStart, start);
    }
    if (rows.length < PAGE) return count;
  }
}

export function createPacer(random: RandomSource): Pacer {
  let gate: Date | null | undefined;
  let untilBreak: number | undefined;
  /** Pieces of work a new engine found in the ledger since the last pause; taken off the first count it draws. */
  let carried = 0;

  const drawBreakCount = (settings: Settings): number =>
    randomInt({ min: settings.breaks.everyActionsMin, max: settings.breaks.everyActionsMax, random });

  return {
    start(db, settings, tick) {
      if (gate !== undefined) return;
      const from = tick.foundInProgress ? tick.now : lastLedgerTime(db);
      if (from === null) {
        gate = null;
        return;
      }
      // Downtime of a pause's length is itself the pause, unless a row was left in progress: then
      // LinkedIn may have acted at any time since it started, and the downtime is not trusted.
      const restedSince = !tick.foundInProgress && tick.now.getTime() - from.getTime() >= settings.breaks.minutesMin * 60_000;
      const pieces = restedSince ? 0 : piecesSincePause(db, settings);
      if (pieces >= settings.breaks.everyActionsMax) {
        gate = new Date(from.getTime() + breakMs(settings, random));
        return;
      }
      carried = pieces;
      gate = new Date(from.getTime() + gapMs(settings, random));
    },

    notBefore() {
      return gate ?? null;
    },

    afterAction(settings, at) {
      untilBreak = (untilBreak ?? drawBreakCount(settings) - carried) - 1;
      carried = 0;
      let pause: number;
      if (untilBreak <= 0) {
        pause = breakMs(settings, random);
        untilBreak = drawBreakCount(settings);
      } else {
        pause = gapMs(settings, random);
      }
      gate = new Date(at.getTime() + pause);
      return gate;
    },
  };
}
