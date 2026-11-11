import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type OpenedDb } from "../db/index";
import { getSettings, setSettings } from "./settings";

let dir: string;
let opened: OpenedDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-settings-"));
  opened = openDb(join(dir, "app.db"));
});

afterEach(() => {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("settings", () => {
  it("starts from the spec defaults on a fresh database", () => {
    expect(getSettings(opened.db)).toEqual({
      timeZone: "Europe/Rome",
      workingDays: [1, 2, 3, 4, 5],
      workingHours: { start: "09:00", end: "18:00" },
      actionGapSeconds: { min: 45, max: 180 },
      breaks: { everyActionsMin: 8, everyActionsMax: 15, minutesMin: 10, minutesMax: 30 },
      limits: {
        invitesPerDay: 15,
        invitesPerWeek: 80,
        profileViewsPerDay: 40,
        messagesPerDay: 10,
        discoveryPagesPerDay: 10,
      },
      warmUp: { enabled: true, invitesStartPerDay: 5, invitesIncreasePerDay: 2 },
    });
  });

  it("round-trips a change and keeps the untouched values", () => {
    setSettings(opened.db, { timeZone: "Europe/London", limits: { invitesPerDay: 8 } });

    const settings = getSettings(opened.db);
    expect(settings.timeZone).toBe("Europe/London");
    expect(settings.limits.invitesPerDay).toBe(8);
    expect(settings.limits.invitesPerWeek).toBe(80);
    expect(settings.workingHours).toEqual({ start: "09:00", end: "18:00" });
  });

  it("survives closing and reopening the database", () => {
    const file = join(dir, "app.db");
    setSettings(opened.db, { workingDays: [1, 2, 3] });
    opened.close();
    opened = openDb(file);
    expect(getSettings(opened.db).workingDays).toEqual([1, 2, 3]);
  });

  it.each([
    ["an unknown time zone", { timeZone: "Mars/Olympus" }],
    ["a negative limit", { limits: { invitesPerDay: -1 } }],
    ["a fractional limit", { limits: { messagesPerDay: 2.5 } }],
    ["a malformed hour", { workingHours: { start: "9am" } }],
    ["hours that end before they start", { workingHours: { start: "18:00", end: "09:00" } }],
    ["a gap whose min exceeds its max", { actionGapSeconds: { min: 200 } }],
    ["a day outside 1-7", { workingDays: [0] }],
    ["no working days", { workingDays: [] }],
  ])("rejects %s and stores nothing", (_label, patch) => {
    expect(() => setSettings(opened.db, patch)).toThrow();
    expect(getSettings(opened.db).limits.invitesPerDay).toBe(15);
    expect(opened.sqlite.prepare("SELECT count(*) AS n FROM settings").get()).toEqual({ n: 0 });
  });
});
