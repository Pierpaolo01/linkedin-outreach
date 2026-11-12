import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../linkedin/fake/world";
import { breakRuns } from "./pieces";

const MINUTE_MS = 60_000;
const start = new Date("2027-03-18T08:00:00Z").getTime();
const at = (minutes: number) => new Date(start + minutes * MINUTE_MS);
const view = (n: number, minutes: number): LogEntry => ({ kind: "profile_view", publicId: `sim-member-${n}`, memberId: `ACoASimMember${n}`, at: at(minutes) });
const invite = (n: number, minutes: number): LogEntry => ({ kind: "invite", publicId: `sim-member-${n}`, memberId: `ACoASimMember${n}`, at: at(minutes) });

/** Fifteen view-and-invite pieces two minutes apart, from `from` minutes on. */
function fifteenFrom(from: number): LogEntry[] {
  return Array.from({ length: 15 }, (_, i) => [view(100 + i, from + 2 * i), invite(100 + i, from + 2 * i + 0.2)]).flat();
}

describe("runs of pieces of work between breaks", () => {
  it("a view and its invite are one piece; sixteen in a row with short gaps are one run of sixteen", () => {
    const log = [view(1, 0), invite(1, 0.5), ...fifteenFrom(2)];
    expect(breakRuns(log, 10 * MINUTE_MS).runs.map((run) => run.pieces)).toEqual([16]);
  });

  it("a pause inside a piece (a send the laptop slept through) is a break: that piece ends its run and the next run starts after it", () => {
    // The view at 0, the invite 87 minutes later, then fifteen pieces two minutes apart.
    const log = [view(1, 0), invite(1, 87), ...fifteenFrom(89)];
    const { runs, pieces } = breakRuns(log, 10 * MINUTE_MS);
    expect(runs.map((run) => run.pieces)).toEqual([1, 15]);
    expect(pieces).toBe(16);
  });

  it("a pause between two pieces is a break, as before", () => {
    const log = [view(1, 0), invite(1, 0.5), ...fifteenFrom(20)];
    expect(breakRuns(log, 10 * MINUTE_MS).runs.map((run) => run.pieces)).toEqual([1, 15]);
  });
});
