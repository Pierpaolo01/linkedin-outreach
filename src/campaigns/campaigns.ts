/**
 * Campaign writes and reads for the dashboard: create and edit the wizard's draft, start, pause,
 * resume, archive, and preview its templates. Every write runs in one transaction and logs a line
 * in the activity log. No LinkedIn activity: the engine acts on what these store.
 */
import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/index";
import { campaigns, people, prospects, type CampaignStatus } from "../db/schema";
import { logEvent, type Conn } from "../engine/ledger";
import { templateValues } from "../engine/steps";
import { conflict, done, invalid, notFound, type Outcome } from "./results";
import {
  isPausable,
  liveEditRefusal,
  moveRefusal,
  previewTexts,
  SAMPLE_VALUES,
  startProblems,
  type CampaignFields,
  type CampaignPatch,
  type PausableStatus,
  type Preview,
  type PreviewTemplates,
} from "./rules";

type CampaignRow = typeof campaigns.$inferSelect;

/** Prospects who reached each step, counted from lifecycle timestamps (a prospect stopped after a reply still counts as invited). */
export interface Funnel {
  readonly found: number;
  readonly approved: number;
  readonly invited: number;
  readonly accepted: number;
  readonly messaged: number;
  readonly replied: number;
}

export type CampaignView = CampaignFields & {
  readonly id: number;
  readonly status: CampaignStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly funnel: Funnel;
};

const EMPTY_FUNNEL: Funnel = { found: 0, approved: 0, invited: 0, accepted: 0, messaged: 0, replied: 0 };

function funnels(db: Conn, campaignIds: readonly number[] | null): Map<number, Funnel> {
  const rows = db
    .select({
      campaignId: prospects.campaignId,
      found: count(),
      approved: count(prospects.approvedAt),
      invited: count(prospects.invitedAt),
      accepted: count(prospects.acceptanceObservedAt),
      messaged: count(prospects.firstMessageSentAt),
      replied: count(prospects.replyDetectedAt),
    })
    .from(prospects)
    .where(campaignIds === null ? undefined : inArray(prospects.campaignId, [...campaignIds]))
    .groupBy(prospects.campaignId)
    .all();
  return new Map(rows.map(({ campaignId, ...funnel }) => [campaignId, funnel]));
}

function view(row: CampaignRow, funnel: Funnel): CampaignView {
  return {
    id: row.id,
    status: row.status,
    name: row.name,
    discoverySource: row.discoverySource,
    sourceUrls: row.sourceUrls,
    targetProspectCount: row.targetProspectCount,
    scoringBrief: row.scoringBrief,
    batchSize: row.batchSize,
    autoApprove: row.autoApprove,
    scoreThreshold: row.scoreThreshold,
    openProfileThreshold: row.openProfileThreshold,
    inviteNote: row.inviteNote,
    firstMessage: row.firstMessage,
    followUp: row.followUp,
    aiPersonalise: row.aiPersonalise,
    personalisationInstructions: row.personalisationInstructions,
    acceptToMessageMinHours: row.acceptToMessageMinHours,
    acceptToMessageMaxHours: row.acceptToMessageMaxHours,
    followUpDelayMinHours: row.followUpDelayMinHours,
    followUpDelayMaxHours: row.followUpDelayMaxHours,
    delayPolicy: row.delayPolicy,
    withdrawAfterDays: row.withdrawAfterDays,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    funnel,
  };
}

function load(db: Conn, id: number): CampaignRow | undefined {
  return db.select().from(campaigns).where(eq(campaigns.id, id)).get();
}

function viewOf(db: Conn, id: number): CampaignView {
  const row = load(db, id);
  if (row === undefined) throw new Error(`campaign ${id} is gone`);
  return view(row, funnels(db, [id]).get(id) ?? EMPTY_FUNNEL);
}

const missing = (id: number) => notFound(`No campaign ${id}`);

/** Strips the fields left out of a patch, so an update writes only what was sent. */
function defined(patch: CampaignPatch): Partial<CampaignFields> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

export function createCampaign(db: Db, patch: CampaignPatch, now: Date): CampaignView {
  return db.transaction((tx) => {
    const { id } = tx
      .insert(campaigns)
      .values({ name: "", discoverySource: "recommendations", ...defined(patch), status: "draft", createdAt: now, updatedAt: now })
      .returning({ id: campaigns.id })
      .get();
    const created = viewOf(tx, id);
    logEvent(tx, { campaignId: id, message: `Campaign "${created.name}" created as a draft` }, now);
    return created;
  });
}

export function getCampaign(db: Db, id: number): Outcome<CampaignView> {
  return load(db, id) === undefined ? missing(id) : done(viewOf(db, id));
}

/** Every campaign, newest first, archived included. */
export function listCampaigns(db: Db): CampaignView[] {
  const rows = db.select().from(campaigns).orderBy(desc(campaigns.id)).all();
  const all = funnels(db, null);
  return rows.map((row) => view(row, all.get(row.id) ?? EMPTY_FUNNEL));
}

export const LIVE_EDIT_NOTICE = "Saved. Edits apply only to steps not yet sent; texts already sent stay as they were.";

/**
 * A draft may change any field. A started campaign may change only templates and timings, and only
 * to values that would pass the checks before start; the answer then carries a notice that edits
 * apply to steps not yet sent. A completed or archived campaign cannot be edited.
 */
export function updateCampaign(
  db: Db,
  id: number,
  patch: CampaignPatch,
  now: Date,
): Outcome<{ readonly campaign: CampaignView; readonly notice: string | null }> {
  return db.transaction((tx) => {
    const row = load(tx, id);
    if (row === undefined) return missing(id);
    const refusal = liveEditRefusal(row.status, patch);
    if (refusal !== null) return conflict(refusal);
    const changes = defined(patch);
    const live = row.status !== "draft";
    if (live) {
      const problems = startProblems({ ...view(row, EMPTY_FUNNEL), ...changes }, { confirmAutoApprove: true });
      if (Object.keys(problems).length > 0) return invalid("These changes cannot be saved while the campaign is live", problems);
    }
    tx.update(campaigns)
      .set({ ...changes, updatedAt: now })
      .where(eq(campaigns.id, id))
      .run();
    const campaign = viewOf(tx, id);
    logEvent(tx, { campaignId: id, message: `Campaign "${campaign.name}" edited: ${Object.keys(changes).join(", ") || "nothing"}` }, now);
    return done({ campaign, notice: live ? LIVE_EDIT_NOTICE : null });
  });
}

/** Sets the status; `pausedFrom` is kept only while the campaign is paused. */
function setStatus(tx: Conn, row: CampaignRow, status: CampaignStatus, message: string, now: Date, pausedFrom: PausableStatus | null = null): CampaignView {
  tx.update(campaigns).set({ status, pausedFrom, updatedAt: now }).where(eq(campaigns.id, row.id)).run();
  logEvent(tx, { campaignId: row.id, message: `Campaign "${row.name}" ${message}` }, now);
  return viewOf(tx, row.id);
}

/** Validates the campaign, then `draft → finding`. Auto-approve needs `confirmAutoApprove`. */
export function startCampaign(db: Db, id: number, { confirmAutoApprove }: { readonly confirmAutoApprove: boolean }, now: Date): Outcome<CampaignView> {
  return db.transaction((tx) => {
    const row = load(tx, id);
    if (row === undefined) return missing(id);
    const refusal = moveRefusal("start", row.status);
    if (refusal !== null) return conflict(refusal);
    const problems = startProblems(view(row, EMPTY_FUNNEL), { confirmAutoApprove });
    if (Object.keys(problems).length > 0) return invalid("The campaign cannot start yet", problems);
    return done(setStatus(tx, row, "finding", "started", now));
  });
}

const statusWords = (status: PausableStatus) => status.replace(/_/g, " ");

/** For a campaign paused before `pausedFrom` was stored: running if anyone was approved, awaiting approval if anyone waits, else finding. */
function inferredStatus(tx: Conn, id: number): PausableStatus {
  const approved = tx.select({ n: count() }).from(prospects).where(and(eq(prospects.campaignId, id), isNotNull(prospects.approvedAt))).get();
  if ((approved?.n ?? 0) > 0) return "running";
  const waiting = tx.select({ n: count() }).from(prospects).where(and(eq(prospects.campaignId, id), eq(prospects.stage, "pending_approval"))).get();
  return (waiting?.n ?? 0) > 0 ? "awaiting_approval" : "finding";
}

/** `finding | awaiting_approval | running → paused`, remembering which. */
export function pauseCampaign(db: Db, id: number, now: Date): Outcome<CampaignView> {
  return db.transaction((tx) => {
    const row = load(tx, id);
    if (row === undefined) return missing(id);
    const refusal = moveRefusal("pause", row.status);
    if (refusal !== null || !isPausable(row.status)) return conflict(refusal ?? "This campaign cannot be paused");
    return done(setStatus(tx, row, "paused", `paused (was ${statusWords(row.status)})`, now, row.status));
  });
}

/**
 * `paused →` the status it was paused from, as stored on pause (approving a prospect while it was
 * paused awaiting approval stores running instead). A campaign paused before that was stored goes
 * where its prospects suggest.
 */
export function resumeCampaign(db: Db, id: number, now: Date): Outcome<CampaignView> {
  return db.transaction((tx) => {
    const row = load(tx, id);
    if (row === undefined) return missing(id);
    const refusal = moveRefusal("resume", row.status);
    if (refusal !== null) return conflict(refusal);
    const to = row.pausedFrom !== null && isPausable(row.pausedFrom) ? row.pausedFrom : inferredStatus(tx, id);
    return done(setStatus(tx, row, to, `resumed (now ${statusWords(to)})`, now));
  });
}

export function archiveCampaign(db: Db, id: number, now: Date): Outcome<CampaignView> {
  return db.transaction((tx) => {
    const row = load(tx, id);
    if (row === undefined) return missing(id);
    const refusal = moveRefusal("archive", row.status);
    if (refusal !== null) return conflict(refusal);
    return done(setStatus(tx, row, "archived", "archived", now));
  });
}

export interface PreviewItem extends Preview {
  /** Null for the invented sample person. */
  readonly prospectId: number | null;
  readonly fullName: string;
}

export interface CampaignPreview {
  /** `prospects` when real prospects were used, `invented` when the campaign has none yet. */
  readonly samples: "prospects" | "invented";
  readonly items: readonly PreviewItem[];
}

export const PREVIEW_PROSPECTS = 3;

/**
 * Renders the campaign's three texts (with `overrides` from an unsaved form on top) against its
 * first three prospects, or invented sample values when it has none.
 */
export function previewCampaign(db: Db, id: number, overrides: Partial<PreviewTemplates>): Outcome<CampaignPreview> {
  const row = load(db, id);
  if (row === undefined) return missing(id);
  const templates: PreviewTemplates = {
    inviteNote: overrides.inviteNote === undefined ? row.inviteNote : overrides.inviteNote,
    firstMessage: overrides.firstMessage ?? row.firstMessage,
    followUp: overrides.followUp ?? row.followUp,
    aiPersonalise: overrides.aiPersonalise ?? row.aiPersonalise,
  };
  const found = db
    .select({ prospect: prospects, person: people })
    .from(prospects)
    .innerJoin(people, eq(people.id, prospects.personId))
    .where(eq(prospects.campaignId, id))
    .orderBy(asc(prospects.id))
    .limit(PREVIEW_PROSPECTS)
    .all();
  if (found.length === 0) {
    return done({
      samples: "invented",
      items: [{ prospectId: null, fullName: "Sample person", ...previewTexts(templates, SAMPLE_VALUES, { aiLineToCome: true }) }],
    });
  }
  return done({
    samples: "prospects",
    items: found.map(({ prospect, person }) => ({
      prospectId: prospect.id,
      fullName: person.fullName,
      // The engine's values for this person; the AI writes a line only while a prospect is found.
      ...previewTexts(templates, templateValues({ person, prospect }), { aiLineToCome: prospect.stage === "found" }),
    })),
  });
}
