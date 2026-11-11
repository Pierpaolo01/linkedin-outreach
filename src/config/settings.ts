import { z } from "zod";
import type { Db } from "../db/index";
import { settings as settingsTable } from "../db/schema";

/**
 * Account-wide settings (spec section 6, pacing defaults). Stored one
 * top-level key per row in the `settings` table, values as JSON.
 */

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM, 24-hour");
const count = z.number().int().nonnegative();
const positive = z.number().int().positive();

const secondsRange = z
  .object({ min: positive, max: positive })
  .refine((r) => r.min <= r.max, "min must not exceed max");

export const settingsSchema = z.object({
  /** IANA time zone the working window and calendar day/week limits are computed in. */
  timeZone: z.string().refine(isTimeZone, "unknown time zone"),
  /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
  workingDays: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .refine((days) => new Set(days).size === days.length, "days must not repeat"),
  workingHours: z
    .object({ start: clock, end: clock })
    .refine((h) => h.start < h.end, "end must be after start"),
  /** Random human gap between two actions. */
  actionGapSeconds: secondsRange,
  /** A random break of minutesMin..minutesMax every everyActionsMin..everyActionsMax actions. */
  breaks: z
    .object({ everyActionsMin: positive, everyActionsMax: positive, minutesMin: positive, minutesMax: positive })
    .refine((b) => b.everyActionsMin <= b.everyActionsMax, "everyActionsMin must not exceed everyActionsMax")
    .refine((b) => b.minutesMin <= b.minutesMax, "minutesMin must not exceed minutesMax"),
  /** Account-wide budgets per calendar day or week in the app's time zone (handoff section 3). */
  limits: z.object({
    invitesPerDay: count,
    invitesPerWeek: count,
    profileViewsPerDay: count,
    /** First messages and follow-ups together. */
    messagesPerDay: count,
    /** Search and recommendation pages together. */
    discoveryPagesPerDay: count,
    /** Withdrawals of old invitations, so a return from downtime does not withdraw them all at once. */
    withdrawalsPerDay: count,
  }),
  /** Invites start at invitesStartPerDay and rise by invitesIncreasePerDay each day up to limits.invitesPerDay. */
  warmUp: z.object({ enabled: z.boolean(), invitesStartPerDay: count, invitesIncreasePerDay: count }),
  /** Days invites stay off after LinkedIn's own invitation-limit message, even once the safety stop is resumed. */
  inviteLimitCooldownDays: count,
});

export type Settings = z.infer<typeof settingsSchema>;

type SettingKey = keyof Settings;

/** A change to some settings; nested groups may be changed one field at a time. */
export type SettingsPatch = {
  readonly [K in SettingKey]?: Settings[K] extends readonly unknown[]
    ? Settings[K]
    : Settings[K] extends object
      ? Partial<Settings[K]>
      : Settings[K];
};

export const DEFAULT_SETTINGS = {
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
    withdrawalsPerDay: 10,
  },
  warmUp: { enabled: true, invitesStartPerDay: 5, invitesIncreasePerDay: 2 },
  inviteLimitCooldownDays: 7,
} as const satisfies Settings;

const SETTING_KEYS = new Set<string>(Object.keys(settingsSchema.shape));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Overlays `patch` on `base`, merging nested groups one level deep. */
function overlay(base: Readonly<Record<string, unknown>>, patch: Readonly<Record<string, unknown>>) {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTING_KEYS.has(key) || value === undefined) continue;
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? { ...current, ...value } : value;
  }
  return merged;
}

/** The current settings: stored values over the defaults. Throws if a stored value is invalid. */
export function getSettings(db: Db): Settings {
  const stored: Record<string, unknown> = {};
  for (const row of db.select().from(settingsTable).all()) stored[row.key] = row.value;
  return settingsSchema.parse(overlay(DEFAULT_SETTINGS, stored));
}

/** Validates the whole result before writing; on error nothing is stored. Returns the new settings. */
export function setSettings(db: Db, patch: SettingsPatch, now: Date = new Date()): Settings {
  const next = settingsSchema.parse(overlay(getSettings(db), patch));
  const changed = Object.keys(patch).filter((key): key is SettingKey => SETTING_KEYS.has(key));
  db.transaction((tx) => {
    for (const key of changed) {
      const value = next[key];
      tx.insert(settingsTable)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: now } })
        .run();
    }
  });
  return next;
}
