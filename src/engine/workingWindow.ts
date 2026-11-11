import type { Settings } from "../config/settings";
import type { DelayPolicy } from "../db/schema";

/**
 * Working-window and calendar maths in the app's time zone (spec section 6,
 * handoff section 3 "Limit windows"). Every function is pure: the instant is
 * an argument and the real clock is never read.
 */

export type WindowSettings = Pick<Settings, "timeZone" | "workingDays" | "workingHours">;

/** A calendar date in some time zone; month is 1–12. */
type LocalDate = { readonly year: number; readonly month: number; readonly day: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock reading of `epochMs` in `timeZone`, read back as if it were UTC (whole seconds). */
function wallClockMs(timeZone: string, epochMs: number): number {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(epochMs)) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  const field = (name: string): number => {
    const value = fields[name];
    if (value === undefined) throw new Error(`Intl.DateTimeFormat gave no ${name} for ${timeZone}`);
    return value;
  };
  return Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
}

/** The zone's offset from UTC at `epochMs`, in milliseconds. */
function offsetAt(timeZone: string, epochMs: number): number {
  const wholeSecond = Math.floor(epochMs / 1000) * 1000;
  return wallClockMs(timeZone, wholeSecond) - wholeSecond;
}

function localDateOf(timeZone: string, at: Date): LocalDate {
  const wall = new Date(wallClockMs(timeZone, at.getTime()));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

/** ISO weekday, 1 = Monday ... 7 = Sunday. */
function isoWeekday(date: LocalDate): number {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/**
 * The instant at wall-clock `minuteOfDay` on `date` in `timeZone`. A wall time
 * skipped by a daylight-saving change moves forward by the gap; a repeated one
 * takes its earlier occurrence (Temporal's "compatible" rule).
 */
function instantAt(timeZone: string, date: LocalDate, minuteOfDay: number): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day) + minuteOfDay * MINUTE_MS;
  const offsetBefore = offsetAt(timeZone, wall - DAY_MS);
  const offsetAfter = offsetAt(timeZone, wall + DAY_MS);
  const candidates = [wall - offsetBefore, wall - offsetAfter].filter(
    (epochMs) => wallClockMs(timeZone, epochMs) === wall,
  );
  if (candidates.length === 0) return new Date(wall - offsetBefore);
  return new Date(Math.min(...candidates));
}

/** Minutes since midnight of an "HH:MM" clock value. */
function minutesOf(clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  if (hours === undefined || minutes === undefined) throw new RangeError(`expected HH:MM, got "${clock}"`);
  return hours * 60 + minutes;
}

/**
 * The window on `date`, or null when `date` is not a working day. Also null on the one day a
 * year when working hours set inside the hour a daylight-saving change skips leave no time at
 * all (start moves forward past or onto end).
 */
function windowOn(settings: WindowSettings, date: LocalDate): { start: Date; end: Date } | null {
  if (!settings.workingDays.includes(isoWeekday(date))) return null;
  const start = instantAt(settings.timeZone, date, minutesOf(settings.workingHours.start));
  const end = instantAt(settings.timeZone, date, minutesOf(settings.workingHours.end));
  return start < end ? { start, end } : null;
}

/** True when `at` falls on a working day, at or after start and before end, in the app's time zone. */
export function isInWorkingWindow(settings: WindowSettings, at: Date): boolean {
  const window = windowOn(settings, localDateOf(settings.timeZone, at));
  return window !== null && window.start <= at && at < window.end;
}

/** `at` itself when inside the window, otherwise the start of the next window. */
export function nextWorkingInstant(settings: WindowSettings, at: Date): Date {
  const today = localDateOf(settings.timeZone, at);
  // workingDays is never empty, so a window opens within the next 7 days; 14 covers the week
  // whose only working day lost its window to a daylight-saving change.
  for (let offset = 0; offset <= 14; offset++) {
    const window = windowOn(settings, addDays(today, offset));
    if (window === null || at >= window.end) continue;
    return at >= window.start ? new Date(at.getTime()) : window.start;
  }
  throw new RangeError("no working day in settings.workingDays");
}

/** The end of the window that contains `at`; throws RangeError when `at` is outside a window. */
export function endOfWorkingWindow(settings: WindowSettings, at: Date): Date {
  const window = windowOn(settings, localDateOf(settings.timeZone, at));
  if (window === null || at < window.start || at >= window.end) {
    throw new RangeError(`${at.toISOString()} is outside the working window`);
  }
  return window.end;
}

/** Local midnight that starts the calendar day containing `at`. */
export function startOfDay(timeZone: string, at: Date): Date {
  return instantAt(timeZone, localDateOf(timeZone, at), 0);
}

export function startOfNextDay(timeZone: string, at: Date): Date {
  return instantAt(timeZone, addDays(localDateOf(timeZone, at), 1), 0);
}

function mondayOf(timeZone: string, at: Date): LocalDate {
  const today = localDateOf(timeZone, at);
  return addDays(today, 1 - isoWeekday(today));
}

/** Monday 00:00 local that starts the calendar week containing `at`. */
export function startOfWeek(timeZone: string, at: Date): Date {
  return instantAt(timeZone, mondayOf(timeZone, at), 0);
}

export function startOfNextWeek(timeZone: string, at: Date): Date {
  return instantAt(timeZone, addDays(mondayOf(timeZone, at), 7), 0);
}

/** The local calendar date, "YYYY-MM-DD". */
export function dayKey(timeZone: string, at: Date): string {
  const { year, month, day } = localDateOf(timeZone, at);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `from` plus `durationMs`, counting only time that falls on a working day (any hour of that day). */
function addWorkingDayTime(settings: WindowSettings, from: Date, durationMs: number): Date {
  if (!settings.workingDays.some((day) => day >= 1 && day <= 7)) {
    throw new RangeError("no working day in settings.workingDays");
  }
  let cursor = from;
  let remaining = durationMs;
  for (;;) {
    const nextDay = startOfNextDay(settings.timeZone, cursor);
    if (settings.workingDays.includes(isoWeekday(localDateOf(settings.timeZone, cursor)))) {
      const available = nextDay.getTime() - cursor.getTime();
      if (remaining <= available) return new Date(cursor.getTime() + remaining);
      remaining -= available;
    }
    cursor = nextDay;
  }
}

/**
 * `from` plus `hours`, then moved to the next working instant.
 * "calendar": plain elapsed time. "working_days": only time that falls on a
 * working day counts (any hour of that day), so 24 h from Friday 15:00 with
 * Mon–Fri working days is Monday 15:00.
 */
export function addDelay(settings: WindowSettings, policy: DelayPolicy, from: Date, hours: number): Date {
  if (!Number.isFinite(hours) || hours < 0) {
    throw new RangeError(`delay must be a finite, non-negative number of hours, got ${hours}`);
  }
  const durationMs = hours * HOUR_MS;
  switch (policy) {
    case "calendar":
      return nextWorkingInstant(settings, new Date(from.getTime() + durationMs));
    case "working_days":
      return nextWorkingInstant(settings, addWorkingDayTime(settings, from, durationMs));
    default: {
      const _exhaustive: never = policy;
      throw new Error(`unknown delay policy ${String(_exhaustive)}`);
    }
  }
}
