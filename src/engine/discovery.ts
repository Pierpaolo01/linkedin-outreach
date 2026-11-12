/**
 * Discovery (spec sections 5 and 7, handoff milestone 3): loading a campaign's discovery source and
 * turning its cards into found prospects, and opening the profile of a prospect whose card scored
 * well enough. Both are LinkedIn reads; what they bring back is stored as LinkedIn shows it.
 */
import { and, count, eq, gt, inArray, isNull, max, notInArray } from "drizzle-orm";
import { campaigns, CLOSED_STAGES, discoveryRuns, people, prospects, type DiscoverySource } from "../db/schema";
import type { Card } from "../linkedin/parse/card";
import type { Profile } from "../linkedin/parse/profile";
import { flattenRecommendations } from "../linkedin/parse/recommendations";
import { logEvent, type Conn } from "./ledger";
import { checkMemberId, loaded, move, needsReview, read, type CampaignRow, type StepContext, type StepOutcome, type Target } from "./steps";
import { dayKey, startOfNextDay } from "./workingWindow";

/**
 * Loads of recommendations in a row that bring no new prospect before the source waits until the
 * next day. LinkedIn's suggestions change, so recommendations are never exhausted for good.
 */
export const EMPTY_LOADS_TO_PAUSE = 3;

/** Stages that count toward a campaign's waiting line: found and not yet decided by the user. */
const WAITING_STAGES = ["found", "pending_approval"] as const;

/** One discovery source of a campaign: its recommendations page, or one of its search URLs. */
export interface SourceRef {
  readonly source: DiscoverySource;
  /** The search URL; null for recommendations. */
  readonly url: string | null;
}

export type RunRow = typeof discoveryRuns.$inferSelect;

/** The campaign's sources in the order they are worked through. */
export function sourcesOf(campaign: Pick<CampaignRow, "discoverySource" | "sourceUrls">): SourceRef[] {
  if (campaign.discoverySource === "recommendations") return [{ source: "recommendations", url: null }];
  return [...new Set(campaign.sourceUrls)].map((url) => ({ source: "search", url }));
}

function runOf(db: Conn, campaignId: number, ref: SourceRef): RunRow | undefined {
  return db
    .select()
    .from(discoveryRuns)
    .where(
      and(
        eq(discoveryRuns.campaignId, campaignId),
        eq(discoveryRuns.source, ref.source),
        ref.url === null ? isNull(discoveryRuns.sourceUrl) : eq(discoveryRuns.sourceUrl, ref.url),
      ),
    )
    .get();
}

/**
 * LinkedIn's search cap is on the account, not on one search: while any search run is paused for
 * it, every search source waits. Null when none is.
 */
export function searchPausedUntil(db: Conn, now: Date): Date | null {
  const row = db
    .select({ until: max(discoveryRuns.pausedUntil) })
    .from(discoveryRuns)
    .where(and(eq(discoveryRuns.source, "search"), gt(discoveryRuns.pausedUntil, now)))
    .get();
  return row?.until ?? null;
}

/** The first source of the campaign that can be loaded now: not exhausted and not paused. Null when none. */
export function availableSource(db: Conn, campaign: CampaignRow, now: Date): SourceRef | null {
  const searchPaused = searchPausedUntil(db, now) !== null;
  for (const ref of sourcesOf(campaign)) {
    if (ref.source === "search" && searchPaused) continue;
    const run = runOf(db, campaign.id, ref);
    if (run === undefined) return ref;
    if (run.exhausted || (run.pausedUntil !== null && run.pausedUntil > now)) continue;
    return ref;
  }
  return null;
}

/**
 * True when some source of the campaign may still bring people, now or after a wait (LinkedIn's
 * search limit, or recommendations that had nobody new today): it is not exhausted.
 */
export function mayDiscoverMore(db: Conn, campaign: CampaignRow): boolean {
  return sourcesOf(campaign).some((ref) => runOf(db, campaign.id, ref)?.exhausted !== true);
}

/**
 * Why discovery for a campaign is waiting: LinkedIn's search limit (until when), LinkedIn's
 * suggestions had nobody new today (until the next day), or every source exhausted.
 */
export type DiscoveryWait =
  | { readonly kind: "search_limit"; readonly until: Date }
  | { readonly kind: "no_new_people"; readonly until: Date }
  | { readonly kind: "exhausted" };

/**
 * Whether discovery for the campaign waits on something only time or the user changes: every one
 * of its sources is exhausted, its recommendations had nobody new today, or (for a search
 * campaign) LinkedIn's search limit holds. Null when it does not wait (it may still have no use
 * for more cards right now).
 */
export function discoveryWait(db: Conn, campaign: Pick<CampaignRow, "id" | "discoverySource" | "sourceUrls">, now: Date): DiscoveryWait | null {
  const refs = sourcesOf(campaign);
  if (refs.length === 0) return null;
  if (refs.every((ref) => runOf(db, campaign.id, ref)?.exhausted === true)) return { kind: "exhausted" };
  if (campaign.discoverySource === "recommendations") {
    const pausedUntil = runOf(db, campaign.id, { source: "recommendations", url: null })?.pausedUntil ?? null;
    return pausedUntil !== null && pausedUntil > now ? { kind: "no_new_people", until: pausedUntil } : null;
  }
  const until = searchPausedUntil(db, now);
  return until === null ? null : { kind: "search_limit", until };
}

function countIn(db: Conn, campaignId: number, stages: readonly (typeof prospects.$inferSelect)["stage"][], exclude = false): number {
  const row = db
    .select({ n: count() })
    .from(prospects)
    .where(and(eq(prospects.campaignId, campaignId), exclude ? notInArray(prospects.stage, [...stages]) : inArray(prospects.stage, [...stages])))
    .get();
  return row?.n ?? 0;
}

/** Prospects of the campaign that are not rejected: what `targetProspectCount` is counted against. */
export function notRejected(db: Conn, campaignId: number): number {
  return countIn(db, campaignId, ["rejected"], true);
}

/** True when the campaign's target number of prospects is set and reached. */
export function targetReached(db: Conn, campaign: CampaignRow): boolean {
  return campaign.targetProspectCount !== null && notRejected(db, campaign.id) >= campaign.targetProspectCount;
}

/** The campaign wants more cards: its waiting line is below the batch size and its target is not reached. */
export function wantsCards(db: Conn, campaign: CampaignRow): boolean {
  return countIn(db, campaign.id, WAITING_STAGES) < campaign.batchSize && !targetReached(db, campaign);
}

/** The first instant of the next calendar month in the app's time zone. */
export function startOfNextMonth(timeZone: string, at: Date): Date {
  let day = startOfNextDay(timeZone, at);
  while (!dayKey(timeZone, day).endsWith("-01")) day = startOfNextDay(timeZone, day);
  return day;
}

// ---------------------------------------------------------------- the discovery page

/** What a load of a source gave: the cards, and for a search whether there is a page after this one. */
interface Loaded {
  readonly cards: readonly Card[];
  readonly hasNextPage: boolean;
}

/** Stored on `people.raw`: what LinkedIn showed of the person, kept as it was shown. */
type RawRecord = Record<string, unknown>;

export function rawRecord(raw: unknown): RawRecord {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return { ...raw };
  return raw === null || raw === undefined ? {} : { previous: raw };
}

function ensureRun(db: Conn, campaignId: number, ref: SourceRef, now: Date): RunRow {
  const existing = runOf(db, campaignId, ref);
  if (existing !== undefined) return existing;
  return db
    .insert(discoveryRuns)
    .values({ campaignId, source: ref.source, sourceUrl: ref.url, cursor: ref.source === "search" ? "1" : null, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

/** The search page a run loads next; the cursor holds it as text. */
function pageOf(run: RunRow): number {
  const page = Number(run.cursor ?? "1");
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/** A stored person who may not become a prospect of the campaign: marked do not contact, ever contacted, active anywhere, or already in it. */
function excluded(db: Conn, campaignId: number, person: typeof people.$inferSelect): boolean {
  if (person.doNotContact || person.contactedAt !== null || person.contactedProspectId !== null) return true;
  const inCampaign = db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(eq(prospects.personId, person.id), eq(prospects.campaignId, campaignId)))
    .get();
  const activeAnywhere = db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(eq(prospects.personId, person.id), notInArray(prospects.stage, [...CLOSED_STAGES])))
    .get();
  return inCampaign !== undefined || activeAnywhere !== undefined;
}

/** What `takeCards` did with a page: how many prospects it created, and whether it considered every card. */
interface Taken {
  readonly created: number;
  /** False when the campaign's target stopped it with a card left that could have been taken. */
  readonly complete: boolean;
}

/**
 * Turns cards into found prospects of the campaign, in one transaction. Skips a 1st-degree card, a
 * person marked do not contact or ever contacted, one with an active prospect anywhere, and one
 * already in this campaign. Stops at the campaign's target number; the page is then complete only
 * when every card left would have been skipped anyway.
 */
function takeCards(db: Conn, campaign: CampaignRow, cards: readonly Card[], now: Date): Taken {
  let room = campaign.targetProspectCount === null ? Number.POSITIVE_INFINITY : campaign.targetProspectCount - notRejected(db, campaign.id);
  let created = 0;
  for (const card of cards) {
    if (card.degree === 1) continue;
    const stored = db.select().from(people).where(eq(people.publicId, card.publicId)).get();
    if (stored !== undefined && excluded(db, campaign.id, stored)) continue;
    if (room <= 0) return { created, complete: false };
    const person =
      stored ??
      db
        .insert(people)
        .values({
          publicId: card.publicId,
          profileUrl: card.profileUrl,
          fullName: card.fullName,
          headline: card.headline,
          location: card.location,
          company: card.company,
          connectionDegree: card.degree,
          discoverySource: campaign.discoverySource,
          raw: { card },
          firstSeenAt: now,
        })
        .returning()
        .get();
    db.insert(prospects).values({ campaignId: campaign.id, personId: person.id, stage: "found", foundAt: now }).run();
    created += 1;
    room -= 1;
  }
  return { created, complete: true };
}

function sourceWords(ref: SourceRef): string {
  return ref.url === null ? "recommendations" : `search ${ref.url}`;
}

/**
 * Loads one page of a campaign's source (budget `discovery_page`) and stores its cards as found
 * prospects. Recommendations have no cursor: after three loads in a row that bring nobody new they
 * wait until the start of the next day in the app's time zone, since LinkedIn's suggestions
 * change. A search keeps the next page number in the cursor and is exhausted after its last page.
 * A page is done only when every card on it was considered: one the campaign's target cut short
 * keeps the cursor on it (and does not count as a load with nobody new).
 * LinkedIn's monthly search cap pauses the search until the first instant of next month; nothing
 * else stops for it.
 */
export async function discoveryPageStep(ctx: StepContext, campaign: CampaignRow, ref: SourceRef): Promise<StepOutcome> {
  const { db, clock, driver } = ctx;
  const run = ensureRun(db, campaign.id, ref, clock.now());
  const page = pageOf(run);
  const url = ref.url;
  const result =
    url === null
      ? await read(ctx, "recommendation_page", null, async (): Promise<Loaded> => ({ cards: flattenRecommendations(await driver.listRecommendations()), hasNextPage: false }), {
          campaignId: campaign.id,
        })
      : await read(ctx, "search_page", null, async (): Promise<Loaded> => driver.searchPeople({ url, page }), { campaignId: campaign.id });
  const label = `discovery: ${campaign.name}, ${sourceWords(ref)}${url === null ? "" : ` page ${page}`}`;
  const at = clock.now();

  if (!result.ok) {
    if (result.kind === "search_capped") {
      const until = startOfNextMonth(ctx.settings.timeZone, at);
      db.transaction((tx) => {
        tx.update(discoveryRuns).set({ pausedUntil: until, updatedAt: at }).where(eq(discoveryRuns.id, run.id)).run();
        logEvent(
          tx,
          {
            level: "warning",
            campaignId: campaign.id,
            message: `LinkedIn's monthly search limit is reached: discovery from searches waits until ${dayKey(ctx.settings.timeZone, until)}. Sequences of existing prospects carry on`,
          },
          at,
        );
      });
      return loaded(`${label}: search limit reached`);
    }
    return loaded(`${label}: not read`);
  }

  const { cards, hasNextPage } = result.value;
  const created = db.transaction((tx) => {
    const fresh = tx.select().from(discoveryRuns).where(eq(discoveryRuns.id, run.id)).get() ?? run;
    // The target as it is now: the user may have changed it while the page loaded.
    const current = tx.select().from(campaigns).where(eq(campaigns.id, campaign.id)).get() ?? campaign;
    const { created: n, complete } = takeCards(tx, current, cards, at);
    // A page the target cut short had someone new on it: not an empty load, and not done. Its
    // search page is loaded again when there is room; those already stored are skipped then.
    const emptyLoads = n > 0 || !complete ? 0 : fresh.emptyLoads + 1;
    const quietToday = url === null && emptyLoads >= EMPTY_LOADS_TO_PAUSE;
    const exhausted = url !== null && complete && !hasNextPage;
    tx.update(discoveryRuns)
      .set({
        emptyLoads: quietToday ? 0 : emptyLoads,
        exhausted,
        cursor: url === null ? null : String(complete ? page + 1 : page),
        ...(quietToday ? { pausedUntil: startOfNextDay(ctx.settings.timeZone, at) } : {}),
        updatedAt: at,
      })
      .where(eq(discoveryRuns.id, run.id))
      .run();
    const more = !complete
      ? "; the target is reached, the rest of this page waits for room"
      : exhausted
        ? `; ${sourceWords(ref)} has nothing more to show`
        : quietToday
          ? "; no new people in LinkedIn's suggestions today; looks again tomorrow"
          : "";
    logEvent(tx, { campaignId: campaign.id, message: `Discovery for ${campaign.name}: ${n} new prospect${n === 1 ? "" : "s"} from ${cards.length} cards (${sourceWords(ref)})${more}` }, at);
    return n;
  });
  return loaded(`${label}: ${created} new`);
}

// ---------------------------------------------------------------- the profile view for scoring

/**
 * Closes a found prospect as rejected before it is scored on its profile (a card below the
 * open-profile threshold, an existing connection, a pending invitation, a profile that is gone):
 * `found → rejected`, in the caller's transaction. `changes` are stored with the rejection (the
 * score, its reason). Returns false when the user had changed the prospect meanwhile; it is then
 * left as he set it.
 */
export function rejectFound(db: Conn, target: Target, changes: Parameters<typeof move>[3], at: Date, message: string): boolean {
  return move(db, target, "rejected", { ...changes, closedAt: at, nextActionAt: null }, at, message);
}

/** Why a profile rules the person out before any scoring (spec section 5), or null. */
export function ruledOut(profile: Pick<Profile, "connectionState" | "degree">): string | null {
  if (profile.connectionState === "connected" || profile.degree === 1) return "already a connection";
  if (profile.connectionState === "pending") return "an invitation is already pending";
  return null;
}

/**
 * Opens the profile of a found prospect whose card scored at or above the open-profile threshold
 * (budget `profile_view`) and stores on the person what it shows. A connection or a pending
 * invitation is rejected, never kept as someone to contact; so is a profile LinkedIn shows as not
 * available. A member id that belongs to someone else holds the prospect for review.
 */
export async function profileViewStep(ctx: StepContext, target: Target): Promise<StepOutcome> {
  const { db, clock, driver } = ctx;
  const { person } = target;
  const name = person.fullName;
  const viewed = await read(ctx, "profile_view", target, () => driver.viewProfile(person.publicId), {
    unavailable: (tx, at) => {
      rejectFound(tx, target, { scoreReason: "the profile is not available" }, at, `${name} rejected: LinkedIn shows the profile as not available`);
    },
  });
  if (!viewed.ok) return loaded(`profile view: ${name} not read`);
  const profile = viewed.value;
  const outcome = db.transaction((tx): string => {
    const at = clock.now();
    // A profile without a Message link shows no member id; the invite step checks it again before any invite.
    if (profile.memberId !== null) {
      const identity = checkMemberId(tx, target, profile.memberId);
      if (!identity.ok) {
        needsReview(tx, target, identity.reason, at);
        return "needs review";
      }
    }
    const stored = tx.select().from(people).where(eq(people.id, person.id)).get() ?? person;
    tx.update(people)
      .set({
        headline: profile.headline ?? stored.headline,
        location: profile.location ?? stored.location,
        title: profile.currentTitle ?? stored.title,
        company: profile.currentCompany ?? stored.company,
        connectionDegree: profile.degree ?? stored.connectionDegree,
        raw: { ...rawRecord(stored.raw), profile },
        profileViewedAt: at,
      })
      .where(eq(people.id, person.id))
      .run();
    const reason = ruledOut(profile);
    if (reason === null) return "stored";
    rejectFound(tx, target, { scoreReason: reason }, at, `${name} rejected: ${reason}`);
    return `rejected (${reason})`;
  });
  return loaded(`profile view: ${name} ${outcome}`);
}
