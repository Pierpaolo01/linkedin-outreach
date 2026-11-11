import { describe, expect, it } from "vitest";
import {
  addDelay,
  dayKey,
  endOfWorkingWindow,
  isInWorkingWindow,
  nextWorkingInstant,
  startOfDay,
  startOfNextDay,
  startOfNextWeek,
  startOfWeek,
  type WindowSettings,
} from "./workingWindow";

/** Mon–Fri 09:00–18:00 in Rome: the spec's default working window. */
const rome: WindowSettings = {
  timeZone: "Europe/Rome",
  workingDays: [1, 2, 3, 4, 5],
  workingHours: { start: "09:00", end: "18:00" },
};

/** Tue, Wed, Sat 08:30–12:15 in New York: non-default days, minutes in the bounds. */
const newYork: WindowSettings = {
  timeZone: "America/New_York",
  workingDays: [2, 3, 6],
  workingHours: { start: "08:30", end: "12:15" },
};

/** Every day 09:00–18:00 in Rome, so the Sunday of a daylight-saving change is itself a working day. */
const romeEveryDay: WindowSettings = { ...rome, workingDays: [1, 2, 3, 4, 5, 6, 7] };

const at = (iso: string) => new Date(iso);

describe("isInWorkingWindow", () => {
  // Thu 2026-11-12 in Rome is UTC+1.
  it("is true at the start instant and inside the hours of a working day", () => {
    expect(isInWorkingWindow(rome, at("2026-11-12T08:00:00Z"))).toBe(true); // 09:00 local
    expect(isInWorkingWindow(rome, at("2026-11-12T13:30:00Z"))).toBe(true); // 14:30 local
    expect(isInWorkingWindow(rome, at("2026-11-12T16:59:59.999Z"))).toBe(true); // 17:59:59.999
  });

  it("is false before the start and at or after the end", () => {
    expect(isInWorkingWindow(rome, at("2026-11-12T07:59:59.999Z"))).toBe(false); // 08:59:59.999
    expect(isInWorkingWindow(rome, at("2026-11-12T17:00:00Z"))).toBe(false); // 18:00, the end instant
    expect(isInWorkingWindow(rome, at("2026-11-12T21:00:00Z"))).toBe(false); // 22:00
  });

  it("is false on a day that is not a working day", () => {
    expect(isInWorkingWindow(rome, at("2026-11-14T10:00:00Z"))).toBe(false); // Sat 11:00
  });

  it("uses the local date, not the UTC date", () => {
    // Fri 2026-11-13 23:30Z is Sat 00:30 in Rome; with hours 00:00–23:59 only Friday counts.
    const allDay: WindowSettings = { ...rome, workingHours: { start: "00:00", end: "23:59" } };
    expect(isInWorkingWindow(allDay, at("2026-11-13T22:30:00Z"))).toBe(true); // Fri 23:30
    expect(isInWorkingWindow(allDay, at("2026-11-13T23:30:00Z"))).toBe(false); // Sat 00:30
  });

  it("honours non-default working days and minute bounds in another zone", () => {
    // New York in November 2026 is UTC−5 (after 1 Nov).
    expect(isInWorkingWindow(newYork, at("2026-11-10T13:30:00Z"))).toBe(true); // Tue 08:30
    expect(isInWorkingWindow(newYork, at("2026-11-10T17:14:00Z"))).toBe(true); // Tue 12:14
    expect(isInWorkingWindow(newYork, at("2026-11-10T17:15:00Z"))).toBe(false); // Tue 12:15, the end
    expect(isInWorkingWindow(newYork, at("2026-11-14T15:00:00Z"))).toBe(true); // Sat 10:00
    expect(isInWorkingWindow(newYork, at("2026-11-12T15:00:00Z"))).toBe(false); // Thu 10:00
  });
});

describe("nextWorkingInstant", () => {
  it("returns the same instant when it is inside the window", () => {
    const inside = at("2026-11-12T13:30:00Z"); // Thu 14:30 Rome
    expect(nextWorkingInstant(rome, inside).toISOString()).toBe("2026-11-12T13:30:00.000Z");
    expect(nextWorkingInstant(rome, at("2026-11-12T08:00:00Z")).toISOString()).toBe("2026-11-12T08:00:00.000Z");
  });

  it("moves an instant before the start to that day's start", () => {
    expect(nextWorkingInstant(rome, at("2026-11-12T06:00:00Z")).toISOString()).toBe("2026-11-12T08:00:00.000Z");
  });

  it("moves the end instant and later to the next working day's start", () => {
    expect(nextWorkingInstant(rome, at("2026-11-12T17:00:00Z")).toISOString()).toBe("2026-11-13T08:00:00.000Z");
    expect(nextWorkingInstant(rome, at("2026-11-12T22:59:00Z")).toISOString()).toBe("2026-11-13T08:00:00.000Z");
  });

  it("moves Friday evening to Monday's start", () => {
    // Fri 2026-11-13 19:00 Rome → Mon 16 09:00 Rome.
    expect(nextWorkingInstant(rome, at("2026-11-13T18:00:00Z")).toISOString()).toBe("2026-11-16T08:00:00.000Z");
  });

  it("follows non-default working days in another zone", () => {
    // Wed 2026-11-11 12:15 New York (the end) → Sat 14 08:30; Sat 13:00 → Tue 17 08:30.
    expect(nextWorkingInstant(newYork, at("2026-11-11T17:15:00Z")).toISOString()).toBe("2026-11-14T13:30:00.000Z");
    expect(nextWorkingInstant(newYork, at("2026-11-14T18:00:00Z")).toISOString()).toBe("2026-11-17T13:30:00.000Z");
  });

  describe("across daylight-saving changes, it lands on the wall-clock start time", () => {
    it("Rome, clocks forward (Sun 2026-03-29, CET → CEST)", () => {
      // Fri 27 18:30 CET → Mon 30 09:00 CEST.
      expect(nextWorkingInstant(rome, at("2026-03-27T17:30:00Z")).toISOString()).toBe("2026-03-30T07:00:00.000Z");
      // Sat 28 19:00 CET → Sun 29 09:00 CEST, the day of the change itself.
      expect(nextWorkingInstant(romeEveryDay, at("2026-03-28T18:00:00Z")).toISOString()).toBe(
        "2026-03-29T07:00:00.000Z",
      );
    });

    it("Rome, clocks back (Sun 2026-10-25, CEST → CET)", () => {
      // Fri 23 20:00 CEST → Mon 26 09:00 CET.
      expect(nextWorkingInstant(rome, at("2026-10-23T18:00:00Z")).toISOString()).toBe("2026-10-26T08:00:00.000Z");
      // Sat 24 19:00 CEST → Sun 25 09:00 CET.
      expect(nextWorkingInstant(romeEveryDay, at("2026-10-24T17:00:00Z")).toISOString()).toBe(
        "2026-10-25T08:00:00.000Z",
      );
    });

    it("New York, clocks forward (Sun 2026-03-08) and back (Sun 2026-11-01)", () => {
      // Sat 2026-03-07 13:00 EST → Tue 10 08:30 EDT.
      expect(nextWorkingInstant(newYork, at("2026-03-07T18:00:00Z")).toISOString()).toBe("2026-03-10T12:30:00.000Z");
      // Sat 2026-10-31 13:00 EDT → Tue Nov 3 08:30 EST.
      expect(nextWorkingInstant(newYork, at("2026-10-31T17:00:00Z")).toISOString()).toBe("2026-11-03T13:30:00.000Z");
    });

    it("moves a start time the change skips forward by the gap", () => {
      // 02:30 does not exist in Rome on 2026-03-29; the window opens at 03:30 CEST.
      const night: WindowSettings = { ...romeEveryDay, workingHours: { start: "02:30", end: "05:00" } };
      expect(nextWorkingInstant(night, at("2026-03-28T05:00:00Z")).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    });
  });
});

describe("endOfWorkingWindow", () => {
  it("returns the end of the window that contains the instant", () => {
    expect(endOfWorkingWindow(rome, at("2026-11-12T08:00:00Z")).toISOString()).toBe("2026-11-12T17:00:00.000Z");
    // Sat 2026-03-07 10:00 EST → 12:15 EST.
    expect(endOfWorkingWindow(newYork, at("2026-03-07T15:00:00Z")).toISOString()).toBe("2026-03-07T17:15:00.000Z");
  });

  it("uses the offset in force at the end when the zone has just changed", () => {
    // Sun 2026-03-29 09:00 CEST; the end is 18:00 CEST.
    expect(endOfWorkingWindow(romeEveryDay, at("2026-03-29T07:00:00Z")).toISOString()).toBe(
      "2026-03-29T16:00:00.000Z",
    );
  });

  it("throws RangeError outside a window, including at the end instant", () => {
    expect(() => endOfWorkingWindow(rome, at("2026-11-12T17:00:00Z"))).toThrow(RangeError);
    expect(() => endOfWorkingWindow(rome, at("2026-11-12T07:00:00Z"))).toThrow(RangeError);
    expect(() => endOfWorkingWindow(rome, at("2026-11-14T10:00:00Z"))).toThrow(RangeError);
  });
});

const iso = (date: Date) => date.toISOString();
const HOUR_MS = 3_600_000;

describe("startOfDay and startOfNextDay", () => {
  it("return the local midnights around the instant", () => {
    expect(iso(startOfDay("Europe/Rome", at("2026-11-12T15:00:00Z")))).toBe("2026-11-11T23:00:00.000Z");
    expect(iso(startOfNextDay("Europe/Rome", at("2026-11-12T15:00:00Z")))).toBe("2026-11-12T23:00:00.000Z");
  });

  it("use the local date when it differs from the UTC date", () => {
    // 2026-11-12 23:30Z is Fri 13 00:30 in Rome and Thu 12 18:30 in New York.
    expect(iso(startOfDay("Europe/Rome", at("2026-11-12T23:30:00Z")))).toBe("2026-11-12T23:00:00.000Z");
    expect(iso(startOfDay("America/New_York", at("2026-11-12T23:30:00Z")))).toBe("2026-11-12T05:00:00.000Z");
  });

  it("return a midnight unchanged as the start of its own day", () => {
    const midnight = at("2026-11-12T23:00:00Z");
    expect(iso(startOfDay("Europe/Rome", midnight))).toBe("2026-11-12T23:00:00.000Z");
    expect(iso(startOfNextDay("Europe/Rome", midnight))).toBe("2026-11-13T23:00:00.000Z");
  });

  it.each([
    ["Europe/Rome", "2026-03-29T10:00:00Z", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z", 23],
    ["Europe/Rome", "2026-10-25T10:00:00Z", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", 25],
    ["America/New_York", "2026-03-08T15:00:00Z", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", 23],
    ["America/New_York", "2026-11-01T15:00:00Z", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", 25],
  ])("give real local midnights on a daylight-saving day (%s, %s)", (zone, instant, start, next, hours) => {
    const dayStart = startOfDay(zone, at(instant));
    const nextStart = startOfNextDay(zone, at(instant));
    expect(iso(dayStart)).toBe(start);
    expect(iso(nextStart)).toBe(next);
    expect((nextStart.getTime() - dayStart.getTime()) / HOUR_MS).toBe(hours);
  });

  it("start the day at its first instant when the zone skips midnight", () => {
    // Santiago moves from 00:00 −04 straight to 01:00 −03 on 2026-09-06.
    expect(iso(startOfDay("America/Santiago", at("2026-09-06T12:00:00Z")))).toBe("2026-09-06T04:00:00.000Z");
    expect(iso(startOfNextDay("America/Santiago", at("2026-09-05T12:00:00Z")))).toBe("2026-09-06T04:00:00.000Z");
  });
});

describe("startOfWeek and startOfNextWeek", () => {
  it("put Sunday 23:59 local in the week that started the Monday before", () => {
    const sunday = at("2026-11-15T22:59:00Z"); // Sun 23:59 Rome
    expect(iso(startOfWeek("Europe/Rome", sunday))).toBe("2026-11-08T23:00:00.000Z");
    expect(iso(startOfNextWeek("Europe/Rome", sunday))).toBe("2026-11-15T23:00:00.000Z");
  });

  it("start a new week at Monday 00:00 local", () => {
    const monday = at("2026-11-15T23:00:00Z"); // Mon 16 00:00 Rome
    expect(iso(startOfWeek("Europe/Rome", monday))).toBe("2026-11-15T23:00:00.000Z");
    expect(iso(startOfNextWeek("Europe/Rome", monday))).toBe("2026-11-22T23:00:00.000Z");
  });

  it("follow the zone, not UTC, in New York", () => {
    // Sun 2026-11-15 23:59 EST is already Monday in UTC; Mon 16 00:00 EST starts the next week.
    expect(iso(startOfWeek("America/New_York", at("2026-11-16T04:59:00Z")))).toBe("2026-11-09T05:00:00.000Z");
    expect(iso(startOfWeek("America/New_York", at("2026-11-16T05:00:00Z")))).toBe("2026-11-16T05:00:00.000Z");
  });

  it("span a daylight-saving change with real local midnights", () => {
    // The week of Sun 2026-10-25 runs Mon 19 00:00 CEST to Mon 26 00:00 CET: 169 hours.
    const start = startOfWeek("Europe/Rome", at("2026-10-25T12:00:00Z"));
    const next = startOfNextWeek("Europe/Rome", at("2026-10-25T12:00:00Z"));
    expect(iso(start)).toBe("2026-10-18T22:00:00.000Z");
    expect(iso(next)).toBe("2026-10-25T23:00:00.000Z");
    expect((next.getTime() - start.getTime()) / HOUR_MS).toBe(169);
  });
});

describe("dayKey", () => {
  it("gives the local date either side of local midnight", () => {
    expect(dayKey("Europe/Rome", at("2026-11-12T22:59:59.999Z"))).toBe("2026-11-12");
    expect(dayKey("Europe/Rome", at("2026-11-12T23:00:00Z"))).toBe("2026-11-13");
  });

  it("differs from the UTC date near midnight UTC", () => {
    // 2026-11-13 00:30Z is 01:30 Fri 13 in Rome and 19:30 Thu 12 in New York.
    expect(dayKey("Europe/Rome", at("2026-11-13T00:30:00Z"))).toBe("2026-11-13");
    expect(dayKey("America/New_York", at("2026-11-13T00:30:00Z"))).toBe("2026-11-12");
    expect(dayKey("America/New_York", at("2026-11-13T05:00:00Z"))).toBe("2026-11-13");
  });

  it("pads month and day and rolls the year", () => {
    expect(dayKey("Europe/Rome", at("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });
});

describe("addDelay", () => {
  describe("calendar", () => {
    it("adds plain elapsed time when the result is inside the window", () => {
      // Thu 2026-11-12 10:00 Rome + 3 h → 13:00.
      expect(iso(addDelay(rome, "calendar", at("2026-11-12T09:00:00Z"), 3))).toBe("2026-11-12T12:00:00.000Z");
    });

    it("moves a result outside the window to the next start", () => {
      // Thu 16:00 + 5 h = 21:00 → Fri 09:00.
      expect(iso(addDelay(rome, "calendar", at("2026-11-12T15:00:00Z"), 5))).toBe("2026-11-13T08:00:00.000Z");
    });

    it("lets a weekend count and then waits for Monday", () => {
      // Fri 2026-11-13 15:00 + 24 h = Sat 15:00 → Mon 16 09:00.
      expect(iso(addDelay(rome, "calendar", at("2026-11-13T14:00:00Z"), 24))).toBe("2026-11-16T08:00:00.000Z");
    });

    it("counts elapsed hours, not wall-clock hours, across a daylight-saving change", () => {
      // Fri 2026-10-23 15:00 CEST + 72 h = Mon 26 14:00 CET.
      expect(iso(addDelay(rome, "calendar", at("2026-10-23T13:00:00Z"), 72))).toBe("2026-10-26T13:00:00.000Z");
    });

    it("accepts fractional hours", () => {
      // Thu 10:00 + 1.5 h = 11:30; Thu 17:45 + 0.25 h = 18:00, the end instant → Fri 09:00.
      expect(iso(addDelay(rome, "calendar", at("2026-11-12T09:00:00Z"), 1.5))).toBe("2026-11-12T10:30:00.000Z");
      expect(iso(addDelay(rome, "calendar", at("2026-11-12T16:45:00Z"), 0.25))).toBe("2026-11-13T08:00:00.000Z");
    });

    it("with zero hours is the next working instant", () => {
      expect(iso(addDelay(rome, "calendar", at("2026-11-14T10:00:00Z"), 0))).toBe("2026-11-16T08:00:00.000Z");
    });
  });

  describe("working_days", () => {
    it("skips the weekend: 24 h from Friday 15:00 is Monday 15:00", () => {
      expect(iso(addDelay(rome, "working_days", at("2026-11-13T14:00:00Z"), 24))).toBe("2026-11-16T14:00:00.000Z");
    });

    it("counts every hour of a working day, then moves a result outside the window to the next start", () => {
      // Thu 15:00 + 6 h = Thu 21:00 → Fri 09:00.
      expect(iso(addDelay(rome, "working_days", at("2026-11-12T14:00:00Z"), 6))).toBe("2026-11-13T08:00:00.000Z");
      // Fri 15:00 + 9 h = Fri 24:00 → Mon 09:00.
      expect(iso(addDelay(rome, "working_days", at("2026-11-13T14:00:00Z"), 9))).toBe("2026-11-16T08:00:00.000Z");
    });

    it("does not count time on a day that is not a working day", () => {
      // Sat 2026-11-14 10:00 + 12 h: Saturday and Sunday do not count, so Mon 12:00.
      expect(iso(addDelay(rome, "working_days", at("2026-11-14T09:00:00Z"), 12))).toBe("2026-11-16T11:00:00.000Z");
    });

    it("follows non-default working days in another zone", () => {
      // NY Tue/Wed/Sat: Wed 2026-11-11 10:00 + 20 h = 14 h of Wednesday + 6 h of Saturday → Sat 08:30.
      expect(iso(addDelay(newYork, "working_days", at("2026-11-11T15:00:00Z"), 20))).toBe("2026-11-14T13:30:00.000Z");
    });

    it("keeps the wall-clock time across a daylight-saving weekend", () => {
      // Fri 2026-10-23 15:00 CEST + 24 h → Mon 26 15:00 CET.
      expect(iso(addDelay(rome, "working_days", at("2026-10-23T13:00:00Z"), 24))).toBe("2026-10-26T14:00:00.000Z");
    });

    it("accepts fractional hours", () => {
      // Fri 2026-11-13 17:00 + 16.75 h = 7 h of Friday + 9.75 h of Monday → Mon 09:45.
      expect(iso(addDelay(rome, "working_days", at("2026-11-13T16:00:00Z"), 16.75))).toBe(
        "2026-11-16T08:45:00.000Z",
      );
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("throws RangeError for %s hours", (hours) => {
    expect(() => addDelay(rome, "calendar", at("2026-11-12T09:00:00Z"), hours)).toThrow(RangeError);
    expect(() => addDelay(rome, "working_days", at("2026-11-12T09:00:00Z"), hours)).toThrow(RangeError);
  });
});

it("throws RangeError instead of searching forever when no day is a working day", () => {
  const never: WindowSettings = { ...rome, workingDays: [] };
  expect(() => nextWorkingInstant(never, at("2026-11-12T09:00:00Z"))).toThrow(RangeError);
  expect(() => addDelay(never, "working_days", at("2026-11-12T09:00:00Z"), 1)).toThrow(RangeError);
});
