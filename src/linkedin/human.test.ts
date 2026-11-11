import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { humanDelay, paceNavigation, randomInt, recordNavigation } from "./human";

function sleepRecorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

describe("randomInt", () => {
  it("covers the whole inclusive range", () => {
    expect(randomInt({ min: 45, max: 180, random: () => 0 })).toBe(45);
    expect(randomInt({ min: 45, max: 180, random: () => 0.999999 })).toBe(180);
    expect(randomInt({ min: 45, max: 180, random: () => 0.5 })).toBe(113);
  });

  it("returns min when the range is a single value", () => {
    expect(randomInt({ min: 7, max: 7, random: () => 0.9 })).toBe(7);
  });

  it("rejects a range whose max is below its min", () => {
    expect(() => randomInt({ min: 10, max: 5 })).toThrow(RangeError);
  });
});

describe("humanDelay", () => {
  it("sleeps a random time in the range and reports it", async () => {
    const { slept, sleep } = sleepRecorder();

    const waited = await humanDelay({ minMs: 1000, maxMs: 3000, random: () => 0.25, sleep });

    expect(waited).toBe(1500);
    expect(slept).toEqual([1500]);
  });
});

describe("paceNavigation", () => {
  const minGapMs = 20_000;
  const maxGapMs = 40_000;
  const t0 = Date.parse("2026-11-11T10:00:00.000Z");

  function stateFile(): string {
    return join(mkdtempSync(join(tmpdir(), "pace-")), "nested", "last-navigation.json");
  }

  it("does not wait when no navigation was recorded, and records this one", async () => {
    const file = stateFile();
    const { slept, sleep } = sleepRecorder();

    const waited = await paceNavigation({ stateFile: file, minGapMs, maxGapMs, random: () => 0, sleep, now: () => t0 });

    expect(waited).toBe(0);
    expect(slept).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ at: "2026-11-11T10:00:00.000Z" });
  });

  it("waits out the rest of a random 20–40 s gap since the last navigation", async () => {
    const file = stateFile();
    recordNavigation({ stateFile: file, at: t0 });
    let clock = t0 + 5_000;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      clock += ms;
    };

    // random 0.5 → a 30 s gap; 5 s have passed, so 25 s remain.
    const waited = await paceNavigation({ stateFile: file, minGapMs, maxGapMs, random: () => 0.5, sleep, now: () => clock });

    expect(waited).toBe(25_000);
    expect(slept).toEqual([25_000]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ at: new Date(t0 + 30_000).toISOString() });
  });

  it("does not wait once the gap has passed", async () => {
    const file = stateFile();
    recordNavigation({ stateFile: file, at: t0 });
    const { slept, sleep } = sleepRecorder();

    await paceNavigation({ stateFile: file, minGapMs, maxGapMs, random: () => 0.999, sleep, now: () => t0 + 41_000 });

    expect(slept).toEqual([]);
  });

  it("waits a full gap when the recorded time is unreadable", async () => {
    const file = stateFile();
    recordNavigation({ stateFile: file, at: t0 });
    writeFileSync(file, "{not json");
    const { slept, sleep } = sleepRecorder();

    await paceNavigation({ stateFile: file, minGapMs, maxGapMs, random: () => 0, sleep, now: () => t0 });

    expect(slept).toEqual([20_000]);
  });

  it("never waits longer than one gap when the recorded time is in the future", async () => {
    const file = stateFile();
    recordNavigation({ stateFile: file, at: t0 + 3_600_000 });
    const { slept, sleep } = sleepRecorder();

    await paceNavigation({ stateFile: file, minGapMs, maxGapMs, random: () => 0, sleep, now: () => t0 });

    expect(slept).toEqual([20_000]);
  });
});
