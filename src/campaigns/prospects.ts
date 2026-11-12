/**
 * Prospect reads and writes for the dashboard: a campaign's prospect table, the approval queue,
 * needs review, and do not contact. Stage moves go through the lifecycle (`assertMove`); every
 * write runs in one transaction and logs a line in the activity log.
 */
import { and, asc, count, desc, eq, gte, inArray, isNotNull, type SQL } from "drizzle-orm";
import type { Db } from "../db/index";
import { actions, campaigns, people, prospects, type CampaignStatus, type ProspectStage } from "../db/schema";
import { logEvent, type Conn } from "../engine/ledger";
import { assertMove, canMove, isClosed, TRANSITIONS } from "../engine/lifecycle";
import { templateValues } from "../engine/steps";
import { conflict, done, notFound, offsetOf, type Outcome, type Page, type Paging } from "./results";
import { previewTexts, type PreviewText } from "./rules";

type PersonRow = typeof people.$inferSelect;
type ProspectRow = typeof prospects.$inferSelect;
type CampaignRow = typeof campaigns.$inferSelect;

export interface PersonView {
  readonly id: number;
  readonly fullName: string;
  readonly firstName: string | null;
  readonly headline: string | null;
  readonly title: string | null;
  readonly company: string | null;
  readonly location: string | null;
  readonly profileUrl: string;
  readonly connectionDegree: number | null;
  readonly industryEvidence: PersonRow["industryEvidence"];
  readonly sizeEvidence: PersonRow["sizeEvidence"];
  readonly doNotContact: boolean;
  /** When this person was first invited by the app; once set they are never contacted from another prospect. */
  readonly contactedAt: Date | null;
}

export interface ProspectView {
  readonly id: number;
  readonly campaignId: number;
  readonly campaignName: string;
  readonly stage: ProspectStage;
  readonly score: number | null;
  readonly cardScore: number | null;
  readonly scoreReason: string | null;
  readonly stopReason: ProspectRow["stopReason"];
  readonly reviewReason: string | null;
  readonly nextActionAt: Date | null;
  /** The texts as sent, frozen once sent; null for a step not sent. */
  readonly texts: { readonly inviteNote: string | null; readonly firstMessage: string | null; readonly followUp: string | null };
  readonly foundAt: Date;
  readonly approvedAt: Date | null;
  readonly invitedAt: Date | null;
  readonly acceptanceObservedAt: Date | null;
  readonly firstMessageSentAt: Date | null;
  readonly followUpSentAt: Date | null;
  readonly replyDetectedAt: Date | null;
  readonly closedAt: Date | null;
  readonly person: PersonView;
}

export interface ApprovalItem extends ProspectView {
  /** The profile text the AI line rests on, as the AI quoted it; null without an AI line. */
  readonly aiLineEvidence: string | null;
  /** The invite note and first message as this person would receive them, or why they cannot be written. */
  readonly preview: { readonly inviteNote: PreviewText | null; readonly firstMessage: PreviewText };
  /** The follow-up as this person would receive it, or why it cannot be written; null when the campaign has none. */
  readonly followUpPreview: PreviewText | null;
}

export interface ReviewItem extends ProspectView {
  /** The newest screenshot on any of this prospect's ledger rows; null when none. */
  readonly screenshotPath: string | null;
  /** Where the dashboard loads that screenshot (`GET /api/screenshots/:name`); null when none or its name is not one the app serves. */
  readonly screenshotUrl: string | null;
}

/** The only screenshot file names the app serves: no folder, no other type. */
export const SCREENSHOT_NAME = /^[A-Za-z0-9._-]+\.png$/;

/** The address of a screenshot in the data directory's `screenshots/` folder, by its file name. */
function screenshotUrl(path: string | null): string | null {
  const name = path?.split(/[\\/]/).at(-1) ?? "";
  return SCREENSHOT_NAME.test(name) ? `/api/screenshots/${name}` : null;
}

function personView(p: PersonRow): PersonView {
  return {
    id: p.id,
    fullName: p.fullName,
    firstName: p.firstName,
    headline: p.headline,
    title: p.title,
    company: p.company,
    location: p.location,
    profileUrl: p.profileUrl,
    connectionDegree: p.connectionDegree,
    industryEvidence: p.industryEvidence,
    sizeEvidence: p.sizeEvidence,
    doNotContact: p.doNotContact,
    contactedAt: p.contactedAt,
  };
}

interface Joined {
  readonly prospect: ProspectRow;
  readonly person: PersonRow;
  readonly campaign: CampaignRow;
}

function prospectView({ prospect: p, person, campaign }: Joined): ProspectView {
  return {
    id: p.id,
    campaignId: p.campaignId,
    campaignName: campaign.name,
    stage: p.stage,
    score: p.score,
    cardScore: p.cardScore,
    scoreReason: p.scoreReason,
    stopReason: p.stopReason,
    reviewReason: p.reviewReason,
    nextActionAt: p.nextActionAt,
    texts: { inviteNote: p.inviteNoteSent, firstMessage: p.firstMessageSent, followUp: p.followUpSent },
    foundAt: p.foundAt,
    approvedAt: p.approvedAt,
    invitedAt: p.invitedAt,
    acceptanceObservedAt: p.acceptanceObservedAt,
    firstMessageSentAt: p.firstMessageSentAt,
    followUpSentAt: p.followUpSentAt,
    replyDetectedAt: p.replyDetectedAt,
    closedAt: p.closedAt,
    person: personView(person),
  };
}

function joined(db: Conn) {
  return db
    .select({ prospect: prospects, person: people, campaign: campaigns })
    .from(prospects)
    .innerJoin(people, eq(people.id, prospects.personId))
    .innerJoin(campaigns, eq(campaigns.id, prospects.campaignId));
}

function paged(db: Conn, where: SQL | undefined, order: readonly SQL[], paging: Paging): Page<Joined> {
  const total = db.select({ n: count() }).from(prospects).where(where).get()?.n ?? 0;
  const items = joined(db)
    .where(where)
    .orderBy(...order)
    .limit(paging.pageSize)
    .offset(offsetOf(paging))
    .all();
  return { ...paging, total, items };
}

const campaignExists = (db: Conn, id: number) => db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, id)).get() !== undefined;
const noCampaign = (id: number) => notFound(`No campaign ${id}`);
const noProspect = (id: number) => notFound(`No prospect ${id}`);
const words = (stage: string) => stage.replace(/_/g, " ");

/** A campaign's prospects, first found first, optionally in one stage. */
export function listProspects(
  db: Db,
  campaignId: number,
  { stage, ...paging }: Paging & { readonly stage: ProspectStage | null },
): Outcome<Page<ProspectView>> {
  if (!campaignExists(db, campaignId)) return noCampaign(campaignId);
  const where = and(eq(prospects.campaignId, campaignId), stage === null ? undefined : eq(prospects.stage, stage));
  const page = paged(db, where, [asc(prospects.id)], paging);
  return done({ ...page, items: page.items.map(prospectView) });
}

/** Prospects in `pending_approval`, best score first, each with a preview of the note, first message and follow-up for that person. */
export function approvalQueue(
  db: Db,
  { campaignId, minScore, ...paging }: Paging & { readonly campaignId: number | null; readonly minScore: number | null },
): Outcome<Page<ApprovalItem>> {
  if (campaignId !== null && !campaignExists(db, campaignId)) return noCampaign(campaignId);
  const where = and(
    eq(prospects.stage, "pending_approval"),
    campaignId === null ? undefined : eq(prospects.campaignId, campaignId),
    minScore === null ? undefined : gte(prospects.score, minScore),
  );
  const page = paged(db, where, [desc(prospects.score), asc(prospects.id)], paging);
  return done({
    ...page,
    items: page.items.map((row) => {
      // Scoring is over for a prospect waiting for approval: a missing AI line stays missing.
      const { inviteNote, firstMessage, followUp } = previewTexts(row.campaign, templateValues(row), { aiLineToCome: false });
      return { ...prospectView(row), aiLineEvidence: row.prospect.aiLineEvidence, preview: { inviteNote, firstMessage }, followUpPreview: followUp };
    }),
  });
}

/** Prospects in `needs_review`, oldest first, each with the reason and the newest screenshot. */
export function reviewQueue(db: Db, { campaignId, ...paging }: Paging & { readonly campaignId: number | null }): Outcome<Page<ReviewItem>> {
  if (campaignId !== null && !campaignExists(db, campaignId)) return noCampaign(campaignId);
  const where = and(eq(prospects.stage, "needs_review"), campaignId === null ? undefined : eq(prospects.campaignId, campaignId));
  const page = paged(db, where, [asc(prospects.id)], paging);
  const ids = page.items.map((row) => row.prospect.id);
  const shots = new Map<number, string>();
  if (ids.length > 0) {
    const rows = db
      .select({ prospectId: actions.prospectId, path: actions.screenshotPath })
      .from(actions)
      .where(and(inArray(actions.prospectId, ids), isNotNull(actions.screenshotPath)))
      .orderBy(asc(actions.id))
      .all();
    for (const { prospectId, path } of rows) if (prospectId !== null && path !== null) shots.set(prospectId, path);
  }
  return done({
    ...page,
    items: page.items.map((row) => {
      const screenshotPath = shots.get(row.prospect.id) ?? null;
      return { ...prospectView(row), screenshotPath, screenshotUrl: screenshotUrl(screenshotPath) };
    }),
  });
}

function loadJoined(db: Conn, id: number): Joined | undefined {
  return joined(db).where(eq(prospects.id, id)).get();
}

function viewOf(db: Conn, id: number): ProspectView {
  const row = loadJoined(db, id);
  if (row === undefined) throw new Error(`prospect ${id} is gone`);
  return prospectView(row);
}

/**
 * After an approval: a campaign awaiting approval starts running. One paused while awaiting
 * approval stays paused but will resume to running. Returns the campaign's status.
 */
function runIfAwaiting(tx: Conn, campaign: Pick<CampaignRow, "id" | "name">, now: Date): CampaignStatus {
  const current = tx.select({ status: campaigns.status, pausedFrom: campaigns.pausedFrom }).from(campaigns).where(eq(campaigns.id, campaign.id)).get();
  if (current?.status === "paused" && current.pausedFrom === "awaiting_approval") {
    tx.update(campaigns).set({ pausedFrom: "running", updatedAt: now }).where(eq(campaigns.id, campaign.id)).run();
    return "paused";
  }
  if (current?.status !== "awaiting_approval") return current?.status ?? "archived";
  tx.update(campaigns).set({ status: "running", updatedAt: now }).where(eq(campaigns.id, campaign.id)).run();
  logEvent(tx, { campaignId: campaign.id, message: `Campaign "${campaign.name}" running: a prospect was approved` }, now);
  return "running";
}

function approveOne(tx: Conn, row: Joined, now: Date): void {
  assertMove(row.prospect.stage, "approved");
  tx.update(prospects).set({ stage: "approved", approvedAt: now }).where(eq(prospects.id, row.prospect.id)).run();
  logEvent(tx, { campaignId: row.campaign.id, prospectId: row.prospect.id, message: `Approved ${row.person.fullName}` }, now);
}

const notWaiting = (what: string, stage: ProspectStage) =>
  conflict(`Only a prospect waiting for approval can be ${what}; this one is ${words(stage)}`);

/** `pending_approval → approved`, with `approvedAt`. A campaign awaiting approval becomes running. */
export function approveProspect(db: Db, id: number, now: Date): Outcome<ProspectView> {
  return db.transaction((tx) => {
    const row = loadJoined(tx, id);
    if (row === undefined) return noProspect(id);
    if (row.prospect.stage !== "pending_approval") return notWaiting("approved", row.prospect.stage);
    approveOne(tx, row, now);
    runIfAwaiting(tx, row.campaign, now);
    return done(viewOf(tx, id));
  });
}

/** `pending_approval → rejected`, closed. */
export function rejectProspect(db: Db, id: number, now: Date): Outcome<ProspectView> {
  return db.transaction((tx) => {
    const row = loadJoined(tx, id);
    if (row === undefined) return noProspect(id);
    if (row.prospect.stage !== "pending_approval") return notWaiting("rejected", row.prospect.stage);
    assertMove(row.prospect.stage, "rejected");
    tx.update(prospects).set({ stage: "rejected", closedAt: now, nextActionAt: null }).where(eq(prospects.id, id)).run();
    logEvent(tx, { campaignId: row.campaign.id, prospectId: id, message: `Rejected ${row.person.fullName}` }, now);
    return done(viewOf(tx, id));
  });
}

/**
 * "Approve all" as the user means it: the prospects he was shown. Each of `prospectIds` still in
 * `pending_approval` is approved; any other (unknown, decided meanwhile) is skipped. Nobody he was
 * not shown is approved, even one scored after the list loaded. Each campaign awaiting approval
 * with an approval becomes running.
 */
export function approveShown(db: Db, prospectIds: readonly number[], now: Date): Outcome<{ readonly approved: number; readonly skipped: number }> {
  return db.transaction((tx) => {
    const rows =
      prospectIds.length === 0
        ? []
        : joined(tx)
            .where(and(inArray(prospects.id, [...prospectIds]), eq(prospects.stage, "pending_approval")))
            .orderBy(asc(prospects.id))
            .all();
    const touched = new Map<number, CampaignRow>();
    for (const row of rows) {
      approveOne(tx, row, now);
      touched.set(row.campaign.id, row.campaign);
    }
    for (const campaign of touched.values()) runIfAwaiting(tx, campaign, now);
    return done({ approved: rows.length, skipped: new Set(prospectIds).size - rows.length });
  });
}

/**
 * Approves every prospect of the campaign waiting for approval, at or above `minScore` when given.
 * Not served by the API (which approves only what the user was shown, `approveShown`): the engine
 * simulation's user approves his whole queue with it.
 */
export function approveAll(
  db: Db,
  { campaignId, minScore }: { readonly campaignId: number; readonly minScore: number | null },
  now: Date,
): Outcome<{ readonly approved: number; readonly campaignStatus: CampaignStatus }> {
  return db.transaction((tx) => {
    const campaign = tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
    if (campaign === undefined) return noCampaign(campaignId);
    const rows = joined(tx)
      .where(
        and(
          eq(prospects.campaignId, campaignId),
          eq(prospects.stage, "pending_approval"),
          minScore === null ? undefined : gte(prospects.score, minScore),
        ),
      )
      .all();
    for (const row of rows) approveOne(tx, row, now);
    const campaignStatus = rows.length > 0 ? runIfAwaiting(tx, campaign, now) : campaign.status;
    return done({ approved: rows.length, campaignStatus });
  });
}

const FROM_REVIEW = TRANSITIONS.needs_review;

/**
 * The user's decision on a prospect in needs review: reject, stop, or back to the stage it should
 * continue from. A closed stage is stamped `closedAt`; any other is due at once, so the engine
 * looks at it on its next tick. The note goes into the activity log.
 */
export function resolveReview(
  db: Db,
  id: number,
  { stage, note }: { readonly stage: ProspectStage; readonly note: string | null },
  now: Date,
): Outcome<ProspectView> {
  return db.transaction((tx) => {
    const row = loadJoined(tx, id);
    if (row === undefined) return noProspect(id);
    if (row.prospect.stage !== "needs_review") {
      return conflict(`Only a prospect in needs review can be resolved; this one is ${words(row.prospect.stage)}`);
    }
    if (!canMove("needs_review", stage)) {
      return conflict(`A prospect in needs review cannot move to ${stage}. Choose ${FROM_REVIEW.slice(0, -1).join(", ")} or ${FROM_REVIEW.at(-1) ?? ""}`);
    }
    assertMove(row.prospect.stage, stage);
    const closed = isClosed(stage);
    // Approving is the user's own decision here, and the engine invites only a prospect with an approval time.
    const approvedAt = stage === "approved" ? (row.prospect.approvedAt ?? now) : row.prospect.approvedAt;
    tx.update(prospects)
      .set({ stage, reviewReason: null, closedAt: closed ? now : null, nextActionAt: closed ? null : now, approvedAt })
      .where(eq(prospects.id, id))
      .run();
    const noted = note === null || note.trim() === "" ? "" : `. Note: ${note.trim()}`;
    logEvent(tx, { campaignId: row.campaign.id, prospectId: id, message: `${row.person.fullName} resolved by the user: now ${words(stage)}${noted}` }, now);
    return done(viewOf(tx, id));
  });
}

/** Sets or clears do not contact on the person (in every campaign). */
export function setDoNotContact(db: Db, personId: number, doNotContact: boolean, now: Date): Outcome<PersonView> {
  return db.transaction((tx) => {
    const person = tx.select().from(people).where(eq(people.id, personId)).get();
    if (person === undefined) return notFound(`No person ${personId}`);
    tx.update(people).set({ doNotContact }).where(eq(people.id, personId)).run();
    const message = `${person.fullName} ${doNotContact ? "marked" : "no longer marked"} do not contact`;
    logEvent(tx, { message }, now);
    return done(personView({ ...person, doNotContact }));
  });
}
