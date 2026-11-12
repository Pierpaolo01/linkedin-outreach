import type { CampaignStatus, ProspectStage } from "../db/schema";
import type { Settings } from "./apiSchemas";

/** Words and dates as the user reads them. Every time shown is in the app's time zone (Settings). */

const LOCALE = "en-GB";

function dayKey(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** -1 yesterday, 0 today, 1 tomorrow, else null. */
function dayOffset(at: Date, timeZone: string, now: Date): -1 | 0 | 1 | null {
  const key = dayKey(at, timeZone);
  if (key === dayKey(now, timeZone)) return 0;
  if (key === dayKey(new Date(now.getTime() + 86_400_000), timeZone)) return 1;
  if (key === dayKey(new Date(now.getTime() - 86_400_000), timeZone)) return -1;
  return null;
}

export function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/** "10:42" today, "11 Nov" another day: for short lists. */
export function formatShort(iso: string, timeZone: string, now: Date): string {
  const at = new Date(iso);
  if (dayOffset(at, timeZone, now) === 0) return formatClock(iso, timeZone);
  return new Intl.DateTimeFormat(LOCALE, { timeZone, day: "numeric", month: "short" }).format(at);
}

/** "today at 10:42", "yesterday at 10:42", "on 9 Nov at 10:42". */
export function formatWhen(iso: string, timeZone: string, now: Date): string {
  const at = new Date(iso);
  const clock = formatClock(iso, timeZone);
  const offset = dayOffset(at, timeZone, now);
  if (offset === 0) return `today at ${clock}`;
  if (offset === -1) return `yesterday at ${clock}`;
  if (offset === 1) return `tomorrow at ${clock}`;
  const date = new Intl.DateTimeFormat(LOCALE, { timeZone, day: "numeric", month: "short" }).format(at);
  return `on ${date} at ${clock}`;
}

/** "tomorrow 09:00", "Monday 09:00", "16 Nov 09:00": when a spent budget opens again. */
export function formatResume(iso: string, timeZone: string, now: Date): string {
  const at = new Date(iso);
  const clock = formatClock(iso, timeZone);
  const offset = dayOffset(at, timeZone, now);
  if (offset === 0) return `today ${clock}`;
  if (offset === 1) return `tomorrow ${clock}`;
  const days = (at.getTime() - now.getTime()) / 86_400_000;
  if (days > 0 && days < 7) return `${new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: "long" }).format(at)} ${clock}`;
  return `${new Intl.DateTimeFormat(LOCALE, { timeZone, day: "numeric", month: "short" }).format(at)} ${clock}`;
}

/** "Thursday 12 November". */
export function formatToday(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: "long", day: "numeric", month: "long" }).format(now);
}

export function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

export function scoreTone(score: number | null): "high" | "mid" | "low" {
  if (score === null) return "low";
  if (score >= 7) return "high";
  if (score >= 5) return "mid";
  return "low";
}

/** "a", "a and b", "a, b and c". */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A fragment from the engine as a sentence: capital first letter, no underscores, a full stop. */
export function asSentence(text: string): string {
  const clean = text.replace(/_/g, " ").trim();
  if (clean === "") return clean;
  const capital = clean.charAt(0).toUpperCase() + clean.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

export const CAMPAIGN_STATUS_LABEL: Readonly<Record<CampaignStatus, string>> = {
  draft: "Draft",
  finding: "Finding people",
  awaiting_approval: "Waiting for approval",
  running: "Running",
  paused: "Paused",
  completed: "Finished",
  archived: "Archived",
};

export const CAMPAIGN_STATUS_DOT: Readonly<Record<CampaignStatus, string>> = {
  draft: "status-neutral",
  finding: "status-info",
  awaiting_approval: "status-warning",
  running: "status-success",
  paused: "status-neutral",
  completed: "status-neutral",
  archived: "status-neutral",
};

export const STAGE_LABEL: Readonly<Record<ProspectStage, string>> = {
  found: "found",
  scored: "scored",
  rejected: "rejected",
  pending_approval: "waiting for approval",
  approved: "approved",
  invited: "invited",
  accepted: "accepted the invite",
  message_sent: "first message sent",
  follow_up_sent: "follow-up sent",
  completed: "finished",
  withdrawn: "invite withdrawn",
  stopped: "stopped",
  needs_review: "needs review",
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const WEEKDAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** "Mon to Fri" for a run of days, else "Mon, Wed and Fri". */
export function formatDays(days: readonly number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) return "";
  const run = sorted.length > 2 && last - first === sorted.length - 1;
  if (run) return `${WEEKDAYS[first - 1] ?? ""} to ${WEEKDAYS[last - 1] ?? ""}`;
  return joinWords(sorted.map((d) => WEEKDAYS[d - 1] ?? ""));
}


/** Whether the working window is open now, and if not, when it next opens ("tomorrow at 09:00"). */
export function workingNow(settings: Settings, now: Date): { readonly open: true; readonly until: string } | { readonly open: false; readonly next: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = WEEKDAYS.indexOf((parts.find((p) => p.type === "weekday")?.value ?? "Mon") as (typeof WEEKDAYS)[number]) + 1;
  const clock = `${parts.find((p) => p.type === "hour")?.value ?? "00"}:${parts.find((p) => p.type === "minute")?.value ?? "00"}`;
  const { start, end } = settings.workingHours;
  const isDay = (isoDay: number) => settings.workingDays.includes(isoDay);
  if (isDay(weekday) && clock >= start && clock < end) return { open: true, until: end };
  if (isDay(weekday) && clock < start) return { open: false, next: `today at ${start}` };
  for (let ahead = 1; ahead <= 7; ahead += 1) {
    const day = ((weekday - 1 + ahead) % 7) + 1;
    if (isDay(day)) return { open: false, next: ahead === 1 ? `tomorrow at ${start}` : `${WEEKDAYS_LONG[day - 1] ?? ""} at ${start}` };
  }
  return { open: false, next: "on the next working day" };
}
