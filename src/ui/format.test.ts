import { describe, expect, it } from "vitest";
import { formatResume, formatShort, formatToday, formatWhen, plural, withStop, workingNow } from "./format";

/** The phrase as the app prints it: its words joined by no-break spaces, so it never breaks across lines. */
const nb = (phrase: string) => phrase.replace(/ /g, " ");

// Thursday 12 November 2026, 10:00 in Rome.
const now = new Date("2026-11-12T09:00:00Z");
const zone = "Europe/Rome";

describe("date and time phrases", () => {
  it("never break inside themselves", () => {
    expect(formatWhen("2026-11-12T06:38:00Z", zone, now)).toBe(nb("today at 07:38"));
    expect(formatWhen("2026-11-11T06:38:00Z", zone, now)).toBe(nb("yesterday at 07:38"));
    expect(formatWhen("2026-11-09T09:42:00Z", zone, now)).toBe(nb("on 9 Nov at 10:42"));
    expect(formatResume("2026-11-16T08:00:00Z", zone, now)).toBe(nb("Monday 09:00"));
    expect(formatResume("2026-11-13T08:00:00Z", zone, now)).toBe(nb("tomorrow 09:00"));
    expect(formatResume("2026-12-01T08:00:00Z", zone, now)).toBe(nb("1 Dec 09:00"));
    expect(formatShort("2026-11-11T09:00:00Z", zone, now)).toBe(nb("11 Nov"));
    expect(formatToday(zone, now)).toBe(nb("Thursday 12 November"));
  });

  it("keep a count with its unit", () => {
    expect(plural(5, "campaign", "campaigns")).toBe(nb("5 campaigns"));
    expect(plural(1, "person", "people")).toBe(nb("1 person"));
  });

  it("say when the working window opens next as one phrase", () => {
    const settings = { timeZone: zone, workingDays: [1, 2, 3, 4, 5], workingHours: { start: "09:00", end: "18:00" } };
    // Thursday 07:00 in Rome: before the window opens today.
    const early = workingNow(settings, new Date("2026-11-12T06:00:00Z"));
    expect(early).toEqual({ open: false, next: nb("today at 09:00") });
    // Friday 19:00 in Rome: next on Monday.
    const late = workingNow(settings, new Date("2026-11-13T18:00:00Z"));
    expect(late).toEqual({ open: false, next: nb("Monday at 09:00") });
  });
});

describe("withStop", () => {
  it("ends a line with exactly one full stop unless it already ends a sentence", () => {
    expect(withStop("Sent an invite to Test Person 10")).toBe("Sent an invite to Test Person 10.");
    expect(withStop("Done.")).toBe("Done.");
    expect(withStop("Done...")).toBe("Done.");
    expect(withStop("Really?")).toBe("Really?");
    expect(withStop("Waiting…")).toBe("Waiting…");
    expect(withStop("Paused (was running)")).toBe("Paused (was running).");
    expect(withStop("")).toBe("");
  });
});
