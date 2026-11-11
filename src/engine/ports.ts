/**
 * What the engine needs from outside itself. Everything that reads the time,
 * waits, or picks at random goes through these, so the simulation can run three
 * weeks in seconds and repeat a run exactly.
 */
export type { Driver, InviteResult, PersonRef, ReadDriver, WithdrawResult, WriteDriver } from "../linkedin/driver";
export type { RandomSource } from "../linkedin/human";

export interface Clock {
  now(): Date;
  /** Resolves after `ms`. The simulation's clock jumps instead of waiting. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
