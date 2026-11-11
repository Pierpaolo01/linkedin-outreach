import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { dataPaths } from "../config/paths";

/** Returns a number in [0, 1), like `Math.random`. Injected so tests are deterministic. */
export type RandomSource = () => number;
/** Injected so tests are instant. */
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A random whole number between min and max, both included. */
export function randomInt({ min, max, random = Math.random }: { min: number; max: number; random?: RandomSource }): number {
  if (max < min) throw new RangeError(`max ${max} is below min ${min}`);
  return min + Math.floor(random() * (max - min + 1));
}

export interface DelayOptions {
  readonly minMs: number;
  readonly maxMs: number;
  readonly random?: RandomSource;
  readonly sleep?: Sleep;
}

/** Sleeps a random time in the range. Returns how long it slept. */
export async function humanDelay({ minMs, maxMs, random = Math.random, sleep = realSleep }: DelayOptions): Promise<number> {
  const ms = randomInt({ min: minMs, max: maxMs, random });
  await sleep(ms);
  return ms;
}

/** Where the time of the last LinkedIn navigation is kept, shared by every process. */
export function navigationStateFile(): string {
  return join(dataPaths().root, "last-navigation.json");
}

const navigationRecord = z.object({ at: z.iso.datetime() });

/** Writes the time of a navigation so the next run, in any process, can pace itself from it. */
export function recordNavigation({ stateFile, at }: { stateFile: string; at: number }): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify({ at: new Date(at).toISOString() })}\n`);
}

/** The recorded time, `undefined` when nothing was recorded, `"unreadable"` when the file is damaged. */
function readNavigation(stateFile: string): number | undefined | "unreadable" {
  let raw: string;
  try {
    raw = readFileSync(stateFile, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return "unreadable";
  }
  try {
    const parsed = navigationRecord.safeParse(JSON.parse(raw));
    return parsed.success ? Date.parse(parsed.data.at) : "unreadable";
  } catch {
    return "unreadable";
  }
}

export interface PaceOptions {
  readonly stateFile: string;
  readonly minGapMs: number;
  readonly maxGapMs: number;
  readonly random?: RandomSource;
  readonly sleep?: Sleep;
  readonly now?: () => number;
}

/**
 * Waits until a random gap has passed since the last recorded navigation,
 * then records this one. Works across runs because the time is kept in a file.
 * An unreadable record or one in the future costs one full gap, never more.
 * Returns how long it waited.
 */
export async function paceNavigation({
  stateFile,
  minGapMs,
  maxGapMs,
  random = Math.random,
  sleep = realSleep,
  now = Date.now,
}: PaceOptions): Promise<number> {
  const gap = randomInt({ min: minGapMs, max: maxGapMs, random });
  const last = readNavigation(stateFile);
  const start = now();
  const remaining =
    last === undefined ? 0 : last === "unreadable" ? gap : Math.min(gap, Math.max(0, last + gap - start));
  if (remaining > 0) await sleep(remaining);
  recordNavigation({ stateFile, at: now() });
  return remaining;
}
