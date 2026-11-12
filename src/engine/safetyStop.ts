/**
 * Safety stops (spec section 6, decision 34): a halt of all LinkedIn activity that only the user
 * lifts. At most one is active at a time; the table keeps every stop ever raised.
 */
import { desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index";
import { safetyStops, type SafetyStopReason } from "../db/schema";
import { logEvent, type Conn } from "./ledger";

export type SafetyStopRow = typeof safetyStops.$inferSelect;

export interface SafetyStopInput {
  readonly reason: SafetyStopReason;
  readonly detail?: string;
  readonly screenshotPath?: string;
  readonly invitesBlockedUntil?: Date;
}

const WHAT_TO_DO: Readonly<Record<SafetyStopReason, string>> = {
  logged_out: "log in to LinkedIn in the app's window, then press Resume",
  checkpoint: "complete LinkedIn's check in the app's window, then press Resume",
  restricted: "read LinkedIn's notice in the app's window before pressing Resume",
  limit_hit: "LinkedIn showed its invitation limit; invites stay off for the cool-down even after Resume",
  unexpected_pages: "three pages in a row were not recognised; run doctor before pressing Resume",
};

/** The newest stop that has not been resumed, or null. */
export function activeSafetyStop(db: Db | Conn): SafetyStopRow | null {
  return (
    db.select().from(safetyStops).where(isNull(safetyStops.resumedAt)).orderBy(desc(safetyStops.id)).limit(1).get() ?? null
  );
}

/**
 * Raises a stop. While one is already active no second row is added; a later invite block is
 * carried over to the active stop, so a limit message is never forgotten.
 */
export function raiseSafetyStop(db: Db | Conn, stop: SafetyStopInput, now: Date): void {
  const active = activeSafetyStop(db);
  if (active !== null) {
    const until = stop.invitesBlockedUntil;
    if (until !== undefined && (active.invitesBlockedUntil === null || active.invitesBlockedUntil < until)) {
      db.update(safetyStops).set({ invitesBlockedUntil: until }).where(eq(safetyStops.id, active.id)).run();
    }
    return;
  }
  db.insert(safetyStops)
    .values({
      reason: stop.reason,
      detail: stop.detail ?? null,
      screenshotPath: stop.screenshotPath ?? null,
      raisedAt: now,
      invitesBlockedUntil: stop.invitesBlockedUntil ?? null,
    })
    .run();
  logEvent(db, { level: "error", message: `Safety stop (${stop.reason}): ${WHAT_TO_DO[stop.reason]}` }, now);
}

/** The user's Resume. Returns false when no stop was active. */
export function resumeSafetyStop(db: Db | Conn, now: Date): boolean {
  const changed = db.update(safetyStops).set({ resumedAt: now }).where(isNull(safetyStops.resumedAt)).run().changes;
  if (changed === 0) return false;
  logEvent(db, { level: "info", message: "Safety stop resumed by the user" }, now);
  return true;
}

/** When the user last resumed a stop; null if never. */
export function lastResumedAt(db: Db | Conn): Date | null {
  const row = db
    .select({ at: safetyStops.resumedAt })
    .from(safetyStops)
    .orderBy(desc(safetyStops.resumedAt))
    .limit(1)
    .get();
  return row?.at ?? null;
}
