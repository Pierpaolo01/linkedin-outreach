/**
 * Read-only views for the dashboard: Home, Stats, the activity log, the ledger and the prospect
 * export. Nothing here writes.
 */
import { and, asc, count, desc, eq, ne, type SQL } from "drizzle-orm";
import { done, notFound, offsetOf, type Outcome, type Page, type Paging } from "../campaigns/results";
import { getSettings } from "../config/settings";
import type { Db } from "../db/index";
import { actions, campaigns, eventLog, people, prospects, type EventLevel } from "../db/schema";
import { BUDGET_KINDS, checkBudget, usageToday } from "../engine/budget";
import { discoveryWait, type DiscoveryWait } from "../engine/discovery";
import { activeSafetyStop, WHAT_TO_DO } from "../engine/safetyStop";
import { dayKey } from "../engine/workingWindow";
import { toCsv, type CsvValue } from "./csv";
import { sessionJson } from "./http";
import { readSession } from "./sessionStore";

/** Discovery's wait as Home shows it: why, until when (null when only the user can change it), in words. */
function waitJson(wait: DiscoveryWait | null, timeZone: string) {
  if (wait === null) return null;
  switch (wait.kind) {
    case "search_limit":
      return { reason: wait.kind, until: wait.until, message: `LinkedIn's monthly search limit; resumes on ${dayKey(timeZone, wait.until)}` };
    case "no_new_people":
      return { reason: wait.kind, until: wait.until, message: "no new people in LinkedIn's suggestions today; looks again tomorrow" };
    case "unreadable":
      return { reason: wait.kind, until: wait.until, message: "LinkedIn's page could not be read; looks again tomorrow" };
    case "exhausted":
      return { reason: wait.kind, until: null, message: "no more people to find from this source" };
    default: {
      const _exhaustive: never = wait;
      return _exhaustive;
    }
  }
}

const campaignExists = (db: Db, id: number) => db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, id)).get() !== undefined;

/** The Home screen: session, safety stop, today's budgets, campaigns not archived, and what waits for the user. */
export function home(db: Db, now: Date, checking: boolean) {
  const settings = getSettings(db);
  const today = usageToday(db, settings, now);
  const usage = Object.fromEntries(
    BUDGET_KINDS.map((kind) => {
      const budget = checkBudget(db, settings, kind, now);
      return [kind, { used: today[kind].used, limit: today[kind].limit, open: budget.allowed, resumesAt: budget.resumesAt }];
    }),
  );
  const stop = activeSafetyStop(db);
  const waiting = (stage: "pending_approval" | "needs_review") =>
    db.select({ n: count() }).from(prospects).where(eq(prospects.stage, stage)).get()?.n ?? 0;
  return {
    session: sessionJson(readSession(db), checking),
    safetyStop:
      stop === null
        ? null
        : {
            reason: stop.reason,
            detail: stop.detail,
            raisedAt: stop.raisedAt,
            whatToDo: WHAT_TO_DO[stop.reason],
            invitesBlockedUntil: stop.invitesBlockedUntil,
          },
    usage,
    campaigns: db
      .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status, discoverySource: campaigns.discoverySource, sourceUrls: campaigns.sourceUrls })
      .from(campaigns)
      .where(ne(campaigns.status, "archived"))
      .orderBy(desc(campaigns.id))
      .all()
      .map(({ discoverySource, sourceUrls, ...campaign }) => ({
        ...campaign,
        // A draft has not started discovering, so it waits on nothing yet.
        discoveryWait: campaign.status === "draft" ? null : waitJson(discoveryWait(db, { id: campaign.id, discoverySource, sourceUrls }, now), settings.timeZone),
      })),
    needsYou: { pendingApproval: waiting("pending_approval"), needsReview: waiting("needs_review") },
  };
}

export const REPLY_RATE_LABEL = "replies seen before the follow-up";

const HOUR_MS = 3_600_000;
const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/**
 * Per campaign, newest first: acceptance rate (accepted ÷ invited), reply rate (replies ÷ first
 * messages, where a reply counts only when seen after a first message was sent), median hours from
 * invite to the acceptance being observed, and invitations withdrawn.
 */
export function stats(db: Db) {
  const rows = db
    .select({
      campaignId: prospects.campaignId,
      stage: prospects.stage,
      invitedAt: prospects.invitedAt,
      acceptedAt: prospects.acceptanceObservedAt,
      firstMessageAt: prospects.firstMessageSentAt,
      replyAt: prospects.replyDetectedAt,
    })
    .from(prospects)
    .all();
  const all = db.select({ id: campaigns.id, name: campaigns.name, status: campaigns.status }).from(campaigns).orderBy(desc(campaigns.id)).all();
  return {
    campaigns: all.map((campaign) => {
      const mine = rows.filter((row) => row.campaignId === campaign.id);
      const invited = mine.filter((row) => row.invitedAt !== null);
      const accepted = mine.filter((row) => row.acceptedAt !== null);
      const messaged = mine.filter((row) => row.firstMessageAt !== null);
      const replied = messaged.filter((row) => row.replyAt !== null);
      const hoursToAccept = invited.flatMap((row) =>
        row.invitedAt !== null && row.acceptedAt !== null ? [(row.acceptedAt.getTime() - row.invitedAt.getTime()) / HOUR_MS] : [],
      );
      return {
        campaignId: campaign.id,
        name: campaign.name,
        status: campaign.status,
        invitesSent: invited.length,
        accepted: accepted.length,
        acceptanceRate: ratio(accepted.length, invited.length),
        firstMessagesSent: messaged.length,
        replies: replied.length,
        replyRate: { label: REPLY_RATE_LABEL, value: ratio(replied.length, messaged.length) },
        medianHoursToAccept: median(hoursToAccept),
        invitesWithdrawn: mine.filter((row) => row.stage === "withdrawn").length,
      };
    }),
  };
}

/** The activity log, newest first. */
export function activity(
  db: Db,
  { campaignId, level, ...paging }: Paging & { readonly campaignId: number | null; readonly level: EventLevel | null },
): Outcome<Page<typeof eventLog.$inferSelect>> {
  if (campaignId !== null && !campaignExists(db, campaignId)) return notFound(`No campaign ${campaignId}`);
  const where = and(campaignId === null ? undefined : eq(eventLog.campaignId, campaignId), level === null ? undefined : eq(eventLog.level, level));
  const total = db.select({ n: count() }).from(eventLog).where(where).get()?.n ?? 0;
  const items = db
    .select()
    .from(eventLog)
    .where(where)
    .orderBy(desc(eventLog.at), desc(eventLog.id))
    .limit(paging.pageSize)
    .offset(offsetOf(paging))
    .all();
  return done({ ...paging, total, items });
}

/** The ledger, newest first, each row with the name of the person it concerned. */
export function ledger(db: Db, { campaignId, ...paging }: Paging & { readonly campaignId: number | null }) {
  if (campaignId !== null && !campaignExists(db, campaignId)) return notFound(`No campaign ${campaignId}`);
  const where: SQL | undefined = campaignId === null ? undefined : eq(actions.campaignId, campaignId);
  const total = db.select({ n: count() }).from(actions).where(where).get()?.n ?? 0;
  const items = db
    .select({
      id: actions.id,
      type: actions.type,
      status: actions.status,
      campaignId: actions.campaignId,
      prospectId: actions.prospectId,
      personName: people.fullName,
      idempotencyKey: actions.idempotencyKey,
      attempts: actions.attempts,
      startedAt: actions.startedAt,
      finishedAt: actions.finishedAt,
      error: actions.error,
      errorKind: actions.errorKind,
      screenshotPath: actions.screenshotPath,
    })
    .from(actions)
    .leftJoin(prospects, eq(prospects.id, actions.prospectId))
    .leftJoin(people, eq(people.id, prospects.personId))
    .where(where)
    .orderBy(desc(actions.id))
    .limit(paging.pageSize)
    .offset(offsetOf(paging))
    .all();
  return done({ ...paging, total, items });
}

const EXPORT_COLUMNS = [
  ["campaign_id", (r) => r.campaign.id],
  ["campaign", (r) => r.campaign.name],
  ["prospect_id", (r) => r.prospect.id],
  ["stage", (r) => r.prospect.stage],
  ["score", (r) => r.prospect.score],
  ["score_reason", (r) => r.prospect.scoreReason],
  ["full_name", (r) => r.person.fullName],
  ["first_name", (r) => r.person.firstName],
  ["headline", (r) => r.person.headline],
  ["title", (r) => r.person.title],
  ["company", (r) => r.person.company],
  ["location", (r) => r.person.location],
  ["profile_url", (r) => r.person.profileUrl],
  ["do_not_contact", (r) => r.person.doNotContact],
  ["found_at", (r) => r.prospect.foundAt],
  ["approved_at", (r) => r.prospect.approvedAt],
  ["invited_at", (r) => r.prospect.invitedAt],
  ["acceptance_observed_at", (r) => r.prospect.acceptanceObservedAt],
  ["first_message_sent_at", (r) => r.prospect.firstMessageSentAt],
  ["follow_up_sent_at", (r) => r.prospect.followUpSentAt],
  ["reply_detected_at", (r) => r.prospect.replyDetectedAt],
  ["closed_at", (r) => r.prospect.closedAt],
  ["stop_reason", (r) => r.prospect.stopReason],
  ["review_reason", (r) => r.prospect.reviewReason],
  ["invite_note_sent", (r) => r.prospect.inviteNoteSent],
  ["first_message_sent", (r) => r.prospect.firstMessageSent],
  ["follow_up_sent", (r) => r.prospect.followUpSent],
] as const satisfies readonly (readonly [string, (row: ExportRow) => CsvValue])[];

interface ExportRow {
  readonly campaign: typeof campaigns.$inferSelect;
  readonly prospect: typeof prospects.$inferSelect;
  readonly person: typeof people.$inferSelect;
}

/** Every prospect (of one campaign, or all), as CSV with a byte-order mark so spreadsheets read UTF-8 names correctly. */
export function exportProspects(db: Db, campaignId: number | null): Outcome<string> {
  if (campaignId !== null && !campaignExists(db, campaignId)) return notFound(`No campaign ${campaignId}`);
  const rows = db
    .select({ campaign: campaigns, prospect: prospects, person: people })
    .from(prospects)
    .innerJoin(campaigns, eq(campaigns.id, prospects.campaignId))
    .innerJoin(people, eq(people.id, prospects.personId))
    .where(campaignId === null ? undefined : eq(prospects.campaignId, campaignId))
    .orderBy(asc(prospects.campaignId), asc(prospects.id))
    .all();
  const header = EXPORT_COLUMNS.map(([name]) => name);
  const body = rows.map((row) => EXPORT_COLUMNS.map(([, value]) => value(row)));
  return done(`\uFEFF${toCsv(header, body)}`);
}
