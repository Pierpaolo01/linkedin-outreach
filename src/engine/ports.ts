/**
 * What the engine needs from outside itself. Everything that reads the time,
 * waits, or picks at random goes through these, so the simulation can run three
 * weeks in seconds and repeat a run exactly.
 */
export type { Driver, InviteResult, PersonRef, ReadDriver, WithdrawResult, WriteDriver } from "../linkedin/driver";
export type { RandomSource } from "../linkedin/human";
import type { Ai } from "../ai/types";
import type { Db } from "../db/index";
import type { Driver } from "../linkedin/driver";
import type { RandomSource } from "../linkedin/human";

export interface Clock {
  now(): Date;
  /** Resolves after `ms`. The simulation's clock jumps instead of waiting. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface EngineDeps {
  readonly db: Db;
  readonly driver: Driver;
  readonly clock: Clock;
  readonly random: RandomSource;
  /**
   * The AI that scores prospects. Without it no AI work is picked, and neither is the LinkedIn work
   * that only feeds it (discovery pages, profile views for scoring).
   */
  readonly ai?: Ai;
  /**
   * False runs the engine read-only on LinkedIn: no invite, message, follow-up, withdrawal,
   * connections check or reconcile of those is picked. Default true.
   */
  readonly outreach?: boolean;
}

export interface TickResult {
  /** What the tick did, in a few words for the log. Null when nothing was due or allowed. */
  readonly did: string | null;
  /** The earliest instant at which another tick could do something. Always later than now. */
  readonly wakeAt: Date;
}

/**
 * The engine does at most one piece of due work per tick and never sleeps by itself: whoever
 * runs it waits until `wakeAt` and calls `tick` again. An engine object holds nothing that
 * matters across a restart; everything it needs to carry on is in the database.
 */
export interface Engine {
  tick(): Promise<TickResult>;
}
