/**
 * The ledger (spec section 4 `actions`, decisions 26–27, 35): claiming a step before it is sent,
 * claiming reads so budgets count them, and finishing either. Also the event log writer.
 *
 * The claim is the rule everything rests on: a step is sent only after one transaction has moved
 * its row from planned to in progress, frozen the text and recorded the suppression. The database
 * then refuses a second send of the same step, whatever the code above it does.
 */
import type Database from "better-sqlite3";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "../db/schema";
import {
  actions,
  campaigns,
  eventLog,
  people,
  prospects,
  type ActionStatus,
  type ActionType,
  type EventLevel,
  type ProspectStage,
} from "../db/schema";

/** The database or a transaction on it. */
export type Conn = BaseSQLiteDatabase<"sync", Database.RunResult, typeof schema>;

export const STEPS = ["invite", "message1", "followup", "withdraw"] as const;
export type Step = (typeof STEPS)[number];

/** The ledger type each step is recorded under (and counted in its budget as). */
export const STEP_TYPE = {
  invite: "invite",
  message1: "message",
  followup: "message",
  withdraw: "withdraw",
} as const satisfies Record<Step, ActionType>;

/** The stage a prospect must be in for the step to be claimed. */
export const STEP_STAGE = {
  invite: "approved",
  message1: "accepted",
  followup: "message_sent",
  withdraw: "invited",
} as const satisfies Record<Step, ProspectStage>;

/** Where the step's text is frozen on the prospect; withdraw has none. */
const FROZEN_COLUMN = {
  invite: "inviteNoteSent",
  message1: "firstMessageSent",
  followup: "followUpSent",
  withdraw: null,
} as const satisfies Record<Step, keyof typeof prospects.$inferSelect | null>;

export function stepKey(step: Step, prospectId: number): string {
  return `${step}:${prospectId}`;
}

/** The step a step row's idempotency key names, or null for a read row. */
export function stepOfKey(key: string): Step | null {
  const prefix = key.slice(0, key.indexOf(":"));
  return STEPS.find((step) => step === prefix) ?? null;
}

export type ActionRow = typeof actions.$inferSelect;

export interface ClaimRequest {
  readonly step: Step;
  readonly prospectId: number;
  /** The rendered text (for an invite: the note, null for none). Ignored when an earlier claim froze one. */
  readonly text: string | null;
  /** What reconcile will need, e.g. `{ userMessagesBefore }`. Replaces any earlier detail. */
  readonly detail?: Record<string, unknown>;
  /**
   * A frozen text longer than this is replaced by `text`: LinkedIn refuses a text over its limit
   * before any effect, so no earlier attempt can have sent it (an invite note over 200 characters).
   */
  readonly replaceFrozenLongerThan?: number;
}

export interface Claim {
  readonly actionId: number;
  /** The text to send: the one frozen by this claim or by an earlier one. */
  readonly text: string | null;
  readonly startedAt: Date;
}

export type ClaimRefusal =
  | "not_planned"
  | "stage_changed"
  | "campaign_not_running"
  | "suppressed"
  | "do_not_contact"
  | "no_member_id"
  | "no_text"
  | "too_many_attempts";

/**
 * Claims of one step allowed in all; the next is refused, so a send that keeps failing is not
 * retried for ever. A claim LinkedIn refused before any effect is given back (`releaseClaim`).
 */
export const MAX_STEP_ATTEMPTS = 3;

export type ClaimResult = { readonly ok: true; readonly claim: Claim } | { readonly ok: false; readonly refusal: ClaimRefusal };

const refuse = (refusal: ClaimRefusal): ClaimResult => ({ ok: false, refusal });

/** Key in an invite row's `detail`: when each attempt started, as epoch milliseconds. */
export const ATTEMPT_STARTS = "attemptStarts";

/** The start times an invite row records for its attempts; empty for a row from before they were recorded. */
export function attemptStarts(detail: Record<string, unknown> | null): number[] {
  const value = detail?.[ATTEMPT_STARTS];
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

/**
 * The detail a claim stores: the request's, replacing any earlier one. An invite also keeps the start
 * of every attempt, since each loads the person's profile and so costs a profile view on its own day,
 * though a retry reuses the row (budget.ts). A row claimed before starts were recorded begins its
 * history with its `startedAt`, the one earlier attempt still known, so the budget keeps that charge;
 * also when `releaseClaim` gave that attempt back, since its profile load happened all the same.
 */
function claimDetail(
  step: Step,
  existing: { readonly detail: Record<string, unknown> | null; readonly startedAt: Date | null } | undefined,
  requested: Record<string, unknown> | undefined,
  now: Date,
): Record<string, unknown> | null {
  if (step !== "invite") return requested ?? null;
  const recorded = attemptStarts(existing?.detail ?? null);
  const earlier =
    recorded.length === 0 && existing !== undefined && existing.startedAt !== null ? [existing.startedAt.getTime()] : recorded;
  return { ...requested, [ATTEMPT_STARTS]: [...earlier, now.getTime()] };
}

/**
 * The text an earlier claim froze for this step, when the step was claimed before (its row has
 * attempts). `{ frozen: false }` when the step was never claimed, so the caller renders it.
 */
export function frozenText(db: Conn, step: Step, prospectId: number): { frozen: true; text: string | null } | { frozen: false } {
  const row = db.select().from(actions).where(eq(actions.idempotencyKey, stepKey(step, prospectId))).get();
  if (row === undefined || row.attempts === 0) return { frozen: false };
  const column = FROZEN_COLUMN[step];
  if (column === null) return { frozen: true, text: null };
  const p = db.select().from(prospects).where(eq(prospects.id, prospectId)).get();
  return { frozen: true, text: p?.[column] ?? null };
}

/**
 * Claims a step in one transaction, or refuses and writes nothing. Checks, in order: the prospect
 * is still in the step's stage and its campaign running; for an invite or a message the person is
 * not marked do-not-contact and has not been contacted by another prospect; the person has a
 * member id; the row is planned (or missing) and has fewer than `MAX_STEP_ATTEMPTS` attempts;
 * there is a text to send. Then inserts the row if
 * missing, moves it planned → in progress (exactly one row must change), freezes the text, stores
 * `detail` and records the suppression.
 */
export function claimStep(db: Conn, request: ClaimRequest, now: Date): ClaimResult {
  const { step, prospectId } = request;
  const key = stepKey(step, prospectId);
  return db.transaction((tx) => {
    const row = tx
      .select({ prospect: prospects, campaign: campaigns, person: people })
      .from(prospects)
      .innerJoin(campaigns, eq(campaigns.id, prospects.campaignId))
      .innerJoin(people, eq(people.id, prospects.personId))
      .where(eq(prospects.id, prospectId))
      .get();
    if (row === undefined || row.prospect.stage !== STEP_STAGE[step]) return refuse("stage_changed");
    if (row.campaign.status !== "running") return refuse("campaign_not_running");
    const contacts = step !== "withdraw";
    if (contacts && row.person.doNotContact) return refuse("do_not_contact");
    if (contacts && row.person.contactedProspectId !== null && row.person.contactedProspectId !== prospectId) {
      return refuse("suppressed");
    }
    if (row.person.memberId === null) return refuse("no_member_id");

    const existing = tx.select().from(actions).where(eq(actions.idempotencyKey, key)).get();
    if (existing !== undefined && existing.status !== "planned") return refuse("not_planned");
    if (existing !== undefined && existing.attempts >= MAX_STEP_ATTEMPTS) return refuse("too_many_attempts");

    const column = FROZEN_COLUMN[step];
    const claimedBefore = existing !== undefined && existing.attempts > 0;
    const frozen = column === null || !claimedBefore ? null : row.prospect[column];
    const limit = request.replaceFrozenLongerThan;
    const keepFrozen = claimedBefore && !(limit !== undefined && frozen !== null && frozen.length > limit);
    const text = column === null ? null : keepFrozen ? frozen : request.text;
    if (step !== "invite" && step !== "withdraw" && (text === null || text.trim() === "")) return refuse("no_text");

    if (existing === undefined) {
      tx.insert(actions)
        .values({ type: STEP_TYPE[step], prospectId, campaignId: row.campaign.id, status: "planned", idempotencyKey: key })
        .run();
    }
    const changed = tx
      .update(actions)
      .set({
        status: "in_progress",
        attempts: sql`${actions.attempts} + 1`,
        startedAt: now,
        finishedAt: null,
        error: null,
        errorKind: null,
        detail: claimDetail(step, existing, request.detail, now),
      })
      .where(and(eq(actions.idempotencyKey, key), eq(actions.status, "planned")))
      .run().changes;
    if (changed !== 1) throw new Error(`claim of ${key} changed ${changed} rows`);

    if (column !== null) {
      tx.update(prospects).set({ [column]: text }).where(eq(prospects.id, prospectId)).run();
    }
    if (contacts) {
      tx.update(people)
        .set({ contactedAt: row.person.contactedAt ?? now, contactedProspectId: prospectId })
        .where(eq(people.id, row.person.id))
        .run();
    }
    const claimed = tx.select({ id: actions.id }).from(actions).where(eq(actions.idempotencyKey, key)).get();
    if (claimed === undefined) throw new Error(`claimed row ${key} is missing`);
    return { ok: true, claim: { actionId: claimed.id, text, startedAt: now } };
  });
}

export interface ReadRequest {
  readonly type: Extract<ActionType, "profile_view" | "thread_check" | "connections_check" | "recommendation_page" | "search_page">;
  readonly prospectId: number | null;
  readonly campaignId: number | null;
}

/** Claims a read: a new ledger row with a generated unique key, in progress from `now`. Returns its id. */
export function claimRead(db: Conn, request: ReadRequest, now: Date): number {
  return db.transaction((tx) => {
    const top = tx.select({ id: max(actions.id) }).from(actions).get()?.id ?? 0;
    return tx
      .insert(actions)
      .values({
        type: request.type,
        prospectId: request.prospectId,
        campaignId: request.campaignId,
        status: "in_progress",
        attempts: 1,
        startedAt: now,
        idempotencyKey: `${request.type}:${top + 1}`,
      })
      .returning({ id: actions.id })
      .get().id;
  });
}

export interface Outcome {
  readonly status: Exclude<ActionStatus, "in_progress">;
  readonly errorKind?: string | null;
  readonly error?: string | null;
  readonly screenshotPath?: string | null;
}

/** Ends an attempt: done, failed, unknown, or back to planned so the step can be claimed again. */
export function finishAction(db: Conn, actionId: number, outcome: Outcome, now: Date): void {
  db.update(actions)
    .set({
      status: outcome.status,
      finishedAt: now,
      errorKind: outcome.errorKind ?? null,
      error: outcome.error ?? null,
      screenshotPath: outcome.screenshotPath ?? null,
    })
    .where(eq(actions.id, actionId))
    .run();
}

/**
 * Puts a claimed step row back to planned when LinkedIn itself refused before any effect (its
 * invitation limit, a conversation that changed, a deadline that passed). Such a claim does not
 * count toward `MAX_STEP_ATTEMPTS`: the attempt is given back. The row keeps `errorKind`, so the
 * ledger still shows why.
 */
export function releaseClaim(db: Conn, actionId: number, refusal: { readonly errorKind: string; readonly error?: string | null }, now: Date): void {
  finishAction(db, actionId, { status: "planned", errorKind: refusal.errorKind, error: refusal.error ?? null }, now);
  db.update(actions)
    .set({ attempts: sql`max(${actions.attempts} - 1, 0)` })
    .where(eq(actions.id, actionId))
    .run();
}

/** Merges fields into a row's detail. */
export function updateDetail(db: Conn, actionId: number, detail: Record<string, unknown>): void {
  const row = db.select({ detail: actions.detail }).from(actions).where(eq(actions.id, actionId)).get();
  db.update(actions)
    .set({ detail: { ...(row?.detail ?? {}), ...detail } })
    .where(eq(actions.id, actionId))
    .run();
}

/** The error kind of a read that a stopped run left in progress. */
export const INTERRUPTED = "interrupted";

/**
 * Closes every row still in progress; with one worker such a row is always left over from a run
 * that died mid-action. A step row becomes unknown, to be reconciled (decision 27). A read has
 * nothing to reconcile, so it ends failed with error kind `interrupted`, finished at `now`.
 * Returns how many rows it closed; writes nothing when there are none.
 */
export function closeInterruptedRows(db: Conn, now: Date): number {
  const open = db.select({ id: actions.id, key: actions.idempotencyKey }).from(actions).where(eq(actions.status, "in_progress")).all();
  if (open.length === 0) return 0;
  const error = "left in progress by a run that stopped";
  const steps = open.filter((row) => stepOfKey(row.key) !== null).map((row) => row.id);
  const reads = open.filter((row) => stepOfKey(row.key) === null).map((row) => row.id);
  return db.transaction((tx) => {
    let changed = 0;
    if (steps.length > 0) {
      changed += tx.update(actions).set({ status: "unknown", error }).where(and(inArray(actions.id, steps), eq(actions.status, "in_progress"))).run().changes;
    }
    if (reads.length > 0) {
      changed += tx
        .update(actions)
        .set({ status: "failed", errorKind: INTERRUPTED, error, finishedAt: now })
        .where(and(inArray(actions.id, reads), eq(actions.status, "in_progress")))
        .run().changes;
    }
    return changed;
  });
}

export interface EventInput {
  readonly level?: EventLevel;
  readonly campaignId?: number | null;
  readonly prospectId?: number | null;
  readonly message: string;
}

/** One human-readable line in the activity log. */
export function logEvent(db: Conn, event: EventInput, at: Date): void {
  db.insert(eventLog)
    .values({
      at,
      level: event.level ?? "info",
      campaignId: event.campaignId ?? null,
      prospectId: event.prospectId ?? null,
      message: event.message,
    })
    .run();
}
