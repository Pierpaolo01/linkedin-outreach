/**
 * Local calendar and working-window maths for the simulation's verdicts. Written apart from
 * `src/engine/workingWindow.ts` on purpose: the simulation must not share the engine's blind spots
 * (daylight saving above all), so it reads wall-clock fields straight from `Intl` and compares them.
 */
import type { Settings } from "../../config/settings";

export type WindowSettings = Pick<Settings, "timeZone" | "workingDays" | "workingHours">;

export interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 1 = Monday ... 7 = Sunday. */
  readonly isoWeekday: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

function format(timeZone: string): Intl.DateTimeFormat {
  let found = formats.get(timeZone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(timeZone, found);
  }
  return found;
}

export function localParts(timeZone: string, at: Date): LocalParts {
  const fields = new Map<string, string>();
  for (const part of format(timeZone).formatToParts(at)) fields.set(part.type, part.value);
  const number = (name: string): number => {
    const value = Number(fields.get(name));
    if (!Number.isFinite(value)) throw new Error(`no ${name} for ${at.toISOString()} in ${timeZone}`);
    return value;
  };
  const isoWeekday = WEEKDAYS[fields.get("weekday") ?? ""];
  if (isoWeekday === undefined) throw new Error(`no weekday for ${at.toISOString()} in ${timeZone}`);
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
    second: number("second"),
    isoWeekday,
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function keyOf(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** The local calendar date, "YYYY-MM-DD". */
export function localDay(timeZone: string, at: Date): string {
  const parts = localParts(timeZone, at);
  return keyOf(parts.year, parts.month, parts.day);
}

/** "YYYY-MM-DD" shifted by whole days. */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  if (year === undefined || month === undefined || date === undefined) throw new RangeError(`not a day: ${day}`);
  const shifted = new Date(Date.UTC(year, month - 1, date) + days * DAY_MS);
  return keyOf(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

export function weekdayOf(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  if (year === undefined || month === undefined || date === undefined) throw new RangeError(`not a day: ${day}`);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** The Monday that starts the local calendar week holding `at`, as "YYYY-MM-DD". */
export function localWeek(timeZone: string, at: Date): string {
  const parts = localParts(timeZone, at);
  return addDays(keyOf(parts.year, parts.month, parts.day), 1 - parts.isoWeekday);
}

/** The instant the wall clock in `timeZone` reads `hh:mm` on `day` (a time that exists that day). */
export function localInstant(timeZone: string, day: string, hour: number, minute = 0): Date {
  const [year, month, date] = day.split("-").map(Number);
  if (year === undefined || month === undefined || date === undefined) throw new RangeError(`not a day: ${day}`);
  const wanted = Date.UTC(year, month - 1, date, hour, minute);
  let guess = wanted;
  for (let round = 0; round < 3; round++) {
    const seen = localParts(timeZone, new Date(guess));
    guess += wanted - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  }
  return new Date(guess);
}

function minutes(clock: string): number {
  const [hours, mins] = clock.split(":").map(Number);
  if (hours === undefined || mins === undefined) throw new RangeError(`expected HH:MM, got ${clock}`);
  return hours * 60 + mins;
}

/** True when `at` is on a working day, at or after the start and strictly before the end, on the local wall clock. */
export function inWorkingWindow(settings: WindowSettings, at: Date): boolean {
  const parts = localParts(settings.timeZone, at);
  if (!settings.workingDays.includes(parts.isoWeekday)) return false;
  const seconds = parts.hour * 3600 + parts.minute * 60 + parts.second;
  return seconds >= minutes(settings.workingHours.start) * 60 && seconds < minutes(settings.workingHours.end) * 60;
}

export function isWorkingDay(settings: WindowSettings, day: string): boolean {
  return settings.workingDays.includes(weekdayOf(day));
}

/** The window's start and end instants on a working day. */
export function windowOn(settings: WindowSettings, day: string): { readonly start: Date; readonly end: Date } {
  const start = minutes(settings.workingHours.start);
  const end = minutes(settings.workingHours.end);
  return {
    start: localInstant(settings.timeZone, day, Math.floor(start / 60), start % 60),
    end: localInstant(settings.timeZone, day, Math.floor(end / 60), end % 60),
  };
}

/** The first working day whose window has not closed at `at`. */
export function firstWorkingDayFrom(settings: WindowSettings, at: Date): string {
  let day = localDay(settings.timeZone, at);
  for (let step = 0; step < 14; step++) {
    if (isWorkingDay(settings, day) && windowOn(settings, day).end.getTime() > at.getTime()) return day;
    day = addDays(day, 1);
  }
  throw new RangeError("no working day within two weeks");
}

/** The last `count` working days whose windows closed at or before `at`, newest first. */
export function lastWorkingDaysBefore(settings: WindowSettings, at: Date, count: number): string[] {
  const days: string[] = [];
  let day = localDay(settings.timeZone, at);
  for (let step = 0; step < 60 && days.length < count; step++) {
    if (isWorkingDay(settings, day) && windowOn(settings, day).end.getTime() <= at.getTime()) days.push(day);
    day = addDays(day, -1);
  }
  return days;
}
