import { and, count, gt, gte, inArray, isNotNull, lt, max } from "drizzle-orm";
import type { Settings } from "../config/settings";
import type { Db } from "../db/index";
import { actions, safetyStops, type ActionType } from "../db/schema";
import { dayKey, nextWorkingInstant, startOfDay, startOfNextDay, startOfNextWeek, startOfWeek } from "./workingWindow";

/**
 * Budgets counted from the ledger (spec section 6 "Global budget", handoff section 3 "Limit windows",
 * decisions 35–36). Every claimed row counts, whatever its status; windows are calendar days and
 * weeks in the app's time zone.
 */

export const BUDGET_KINDS = ["invite", "message", "profile_view", "discovery_page", "withdraw"] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

export interface BudgetAnswer {
  readonly allowed: boolean;
  readonly reason: "ok" | "day_limit" | "week_limit" | "invites_blocked";
  /** Used and allowed today (for invites: today's warm-up allowance). */
  readonly used: number;
  readonly limit: number;
  /** When not allowed: the first working instant at which this budget is open again. Null when allowed. */
  readonly resumesAt: Date | null;
}

const LEDGER_TYPES = {
  invite: ["invite"],
  message: ["message"],
  profile_view: ["profile_view"],
  discovery_page: ["search_page", "recommendation_page"],
  withdraw: ["withdraw"],
} as const satisfies Record<BudgetKind, readonly [ActionType, ...ActionType[]]>;

const DAY_LIMIT_KEYS = {
  invite: "invitesPerDay",
  message: "messagesPerDay",
  profile_view: "profileViewsPerDay",
  discovery_page: "discoveryPagesPerDay",
  withdraw: "withdrawalsPerDay",
} as const satisfies Record<BudgetKind, keyof Settings["limits"]>;

/** Claimed ledger rows of `kind` started in `[from, to)`. A null `startedAt` never matches. */
function countClaimed(db: Db, kind: BudgetKind, from: Date, to: Date): number {
  const row = db
    .select({ n: count() })
    .from(actions)
    .where(and(inArray(actions.type, LEDGER_TYPES[kind]), gte(actions.startedAt, from), lt(actions.startedAt, to)))
    .get();
  return row?.n ?? 0;
}

type Refusal = { readonly reason: Exclude<BudgetAnswer["reason"], "ok">; readonly resumesAt: Date };

/**
 * Today's invite allowance under warm-up: invitesStartPerDay plus invitesIncreasePerDay for every
 * earlier local calendar day with at least one claimed invite, capped at limits.invitesPerDay.
 * Days without invites (downtime) do not advance it.
 */
export function inviteAllowance(db: Db, settings: Settings, now: Date): number {
  const cap = settings.limits.invitesPerDay;
  const { enabled, invitesStartPerDay, invitesIncreasePerDay } = settings.warmUp;
  if (!enabled) return cap;
  const earlier = db
    .select({ startedAt: actions.startedAt })
    .from(actions)
    .where(
      and(
        inArray(actions.type, LEDGER_TYPES.invite),
        isNotNull(actions.startedAt),
        lt(actions.startedAt, startOfDay(settings.timeZone, now)),
      ),
    )
    .all();
  const days = new Set<string>();
  for (const { startedAt } of earlier) if (startedAt !== null) days.add(dayKey(settings.timeZone, startedAt));
  return Math.min(cap, invitesStartPerDay + invitesIncreasePerDay * days.size);
}

function dayLimit(db: Db, settings: Settings, kind: BudgetKind, now: Date): number {
  return kind === "invite" ? inviteAllowance(db, settings, now) : settings.limits[DAY_LIMIT_KEYS[kind]];
}

/** The latest `invitesBlockedUntil` after `now` on any safety stop, resumed or not; null when none. */
function invitesBlockedUntil(db: Db, now: Date): Date | null {
  const row = db
    .select({ until: max(safetyStops.invitesBlockedUntil) })
    .from(safetyStops)
    .where(gt(safetyStops.invitesBlockedUntil, now))
    .get();
  return row?.until ?? null;
}

/** Why `kind` is closed now, each with when it opens again; empty when open. */
function refusals(db: Db, settings: Settings, kind: BudgetKind, now: Date, used: number, limit: number): Refusal[] {
  const { timeZone } = settings;
  const found: Refusal[] = [];
  if (kind === "invite") {
    const blockedUntil = invitesBlockedUntil(db, now);
    if (blockedUntil !== null) {
      found.push({ reason: "invites_blocked", resumesAt: nextWorkingInstant(settings, blockedUntil) });
    }
    const weekEnd = startOfNextWeek(timeZone, now);
    if (countClaimed(db, kind, startOfWeek(timeZone, now), weekEnd) >= settings.limits.invitesPerWeek) {
      found.push({ reason: "week_limit", resumesAt: nextWorkingInstant(settings, weekEnd) });
    }
  }
  if (used >= limit) {
    found.push({ reason: "day_limit", resumesAt: nextWorkingInstant(settings, startOfNextDay(timeZone, now)) });
  }
  return found;
}

export function checkBudget(db: Db, settings: Settings, kind: BudgetKind, now: Date): BudgetAnswer {
  const used = countClaimed(db, kind, startOfDay(settings.timeZone, now), startOfNextDay(settings.timeZone, now));
  const limit = dayLimit(db, settings, kind, now);
  // The reason that lasts longest wins; on a tie the earlier entry (block, then week, then day).
  const latest = refusals(db, settings, kind, now, used, limit).reduce<Refusal | null>(
    (best, next) => (best === null || next.resumesAt.getTime() > best.resumesAt.getTime() ? next : best),
    null,
  );
  if (latest === null) return { allowed: true, reason: "ok", used, limit, resumesAt: null };
  return { allowed: false, reason: latest.reason, used, limit, resumesAt: latest.resumesAt };
}

/** Today's usage of every budget, for the Home screen. */
export function usageToday(
  db: Db,
  settings: Settings,
  now: Date,
): Readonly<Record<BudgetKind, { used: number; limit: number }>> {
  const from = startOfDay(settings.timeZone, now);
  const to = startOfNextDay(settings.timeZone, now);
  const usage = (kind: BudgetKind) => ({
    used: countClaimed(db, kind, from, to),
    limit: dayLimit(db, settings, kind, now),
  });
  return {
    invite: usage("invite"),
    message: usage("message"),
    profile_view: usage("profile_view"),
    discovery_page: usage("discovery_page"),
    withdraw: usage("withdraw"),
  };
}
