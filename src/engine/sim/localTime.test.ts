import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../config/settings";
import {
  addDays,
  firstWorkingDayFrom,
  inWorkingWindow,
  lastWorkingDaysBefore,
  localDay,
  localInstant,
  localWeek,
  windowOn,
} from "./localTime";

const ROME = "Europe/Rome";

describe("simulation local time (Europe/Rome, across the 2027-03-28 change)", () => {
  it("09:00 is 08:00 UTC before the change and 07:00 UTC after it", () => {
    expect(localInstant(ROME, "2027-03-26", 9).toISOString()).toBe("2027-03-26T08:00:00.000Z");
    expect(localInstant(ROME, "2027-03-29", 9).toISOString()).toBe("2027-03-29T07:00:00.000Z");
  });

  it("the window is Monday to Friday, start included, end excluded, on the local wall clock", () => {
    expect(inWorkingWindow(DEFAULT_SETTINGS, new Date("2027-03-29T07:00:00Z"))).toBe(true);
    expect(inWorkingWindow(DEFAULT_SETTINGS, new Date("2027-03-29T06:59:59Z"))).toBe(false);
    expect(inWorkingWindow(DEFAULT_SETTINGS, new Date("2027-03-29T15:59:59Z"))).toBe(true);
    expect(inWorkingWindow(DEFAULT_SETTINGS, new Date("2027-03-29T16:00:00Z"))).toBe(false);
    // 08:30 UTC on a Monday before the change is 09:30 local; the same UTC time on Saturday is not a working day.
    expect(inWorkingWindow(DEFAULT_SETTINGS, new Date("2027-03-22T08:30:00Z"))).toBe(true);
    expect(inWorkingWindow(DEFAULT_SETTINGS, new Date("2027-03-27T08:30:00Z"))).toBe(false);
  });

  it("days and weeks are local: 23:30 UTC on Sunday 28 March is already Monday 29 in Rome", () => {
    expect(localDay(ROME, new Date("2027-03-28T23:30:00Z"))).toBe("2027-03-29");
    expect(localWeek(ROME, new Date("2027-03-28T23:30:00Z"))).toBe("2027-03-29");
    expect(localWeek(ROME, new Date("2027-03-28T20:00:00Z"))).toBe("2027-03-22");
    expect(addDays("2027-03-31", 1)).toBe("2027-04-01");
  });

  it("finds the next working day and the last ones before an instant", () => {
    expect(firstWorkingDayFrom(DEFAULT_SETTINGS, new Date("2027-03-26T17:30:00Z"))).toBe("2027-03-29");
    expect(lastWorkingDaysBefore(DEFAULT_SETTINGS, new Date("2027-04-05T06:00:00Z"), 2)).toEqual(["2027-04-02", "2027-04-01"]);
    expect(windowOn(DEFAULT_SETTINGS, "2027-04-01").end.toISOString()).toBe("2027-04-01T16:00:00.000Z");
  });
});
