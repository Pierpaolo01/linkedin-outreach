/**
 * Scoring (spec sections 5 and 8): the work that needs the AI but not LinkedIn, and the campaign
 * status moves that need neither. None of it is held by the working window, the pacing gate or a
 * safety stop. At most one AI call is made per piece of work; a prospect's profile scoring, cleaned
 * variables and personal line are separate pieces, and only the last one moves it on.
 */
import { and, asc, count, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import type { Ai, CardForScoring, ProfileForScoring } from "../ai/types";
import type { ConnectionState } from "../linkedin/parse/profile";
import { campaigns, people, prospects, type CampaignStatus, type ProspectStage } from "../db/schema";
import { availableSource, mayDiscoverMore, rawRecord, rejectFound, ruledOut, targetReached } from "./discovery";
import { logEvent, type Conn } from "./ledger";
import type { Clock } from "./ports";
import { move, type CampaignRow, type PersonRow, type Target } from "./steps";

/** Cards scored in one AI call. */
export const CARD_BATCH = 10;

/** Campaign statuses in which prospects are discovered and scored. */
export const COLLECTING: readonly CampaignStatus[] = ["finding", "running"];

export type LocalWork =
  /** A found prospect whose card score is below the open-profile threshold (raised after it was scored): rejected without AI. */
  | { readonly kind: "reject_card"; readonly target: Target }
  | { readonly kind: "score_cards"; readonly campaign: CampaignRow; readonly targets: readonly Target[] }
  | { readonly kind: "score_profile"; readonly target: Target }
  | { readonly kind: "campaign_status"; readonly campaign: CampaignRow; readonly from: CampaignStatus; readonly to: CampaignStatus; readonly message: string };

export interface ScoringContext {
  readonly db: Conn;
  readonly clock: Clock;
}

function foundTargets(db: Conn, where: ReturnType<typeof and>, limit: number): Target[] {
  return db
    .select({ prospect: prospects, campaign: campaigns, person: people })
    .from(prospects)
    .innerJoin(campaigns, eq(campaigns.id, prospects.campaignId))
    .innerJoin(people, eq(people.id, prospects.personId))
    .where(and(eq(prospects.stage, "found"), inArray(campaigns.status, COLLECTING), where))
    .orderBy(asc(prospects.foundAt), asc(prospects.id))
    .limit(limit)
    .all();
}

/** The next AI work (only when `withAi`), or a campaign status move. Null when there is none. */
export function pickLocalWork(db: Conn, now: Date, withAi: boolean): LocalWork | null {
  const belowOpen = foundTargets(db, and(isNotNull(prospects.cardScore), isNull(prospects.score), isNull(people.profileViewedAt), lt(prospects.cardScore, campaigns.openProfileThreshold)), 1)[0];
  if (belowOpen !== undefined) return { kind: "reject_card", target: belowOpen };
  if (withAi) {
    const first = foundTargets(db, isNull(prospects.cardScore), 1)[0];
    if (first !== undefined) {
      const targets = foundTargets(db, and(isNull(prospects.cardScore), eq(prospects.campaignId, first.campaign.id)), CARD_BATCH);
      return { kind: "score_cards", campaign: first.campaign, targets };
    }
    const viewed = foundTargets(db, and(isNotNull(prospects.cardScore), isNotNull(people.profileViewedAt)), 1)[0];
    if (viewed !== undefined) return { kind: "score_profile", target: viewed };
  }
  return campaignStatusWork(db, now);
}

function stageCount(db: Conn, campaignId: number, stage: ProspectStage): number {
  return db.select({ n: count() }).from(prospects).where(and(eq(prospects.campaignId, campaignId), eq(prospects.stage, stage))).get()?.n ?? 0;
}

/** Prospects waiting for approval, and those waiting for approval or approved already. */
function readyCounts(db: Conn, campaignId: number): { readonly pending: number; readonly ready: number } {
  const pending = stageCount(db, campaignId, "pending_approval");
  return { pending, ready: pending + stageCount(db, campaignId, "approved") };
}

/**
 * More prospects may still come: some found are still to be scored, or the target is not reached
 * and a source may bring more, now or after a wait (recommendations are never exhausted for good).
 */
function moreToCome(db: Conn, campaign: CampaignRow): boolean {
  if (stageCount(db, campaign.id, "found") > 0) return true;
  return !targetReached(db, campaign) && mayDiscoverMore(db, campaign);
}

/**
 * A campaign in `finding` moves on once its first batch is ready (prospects waiting for approval, or
 * approved already, reach the batch size), or once nothing is left to discover or score now and at
 * least one is ready. With none ready and nothing that can ever come it is completed: nobody matched.
 * A campaign `awaiting_approval` whose prospects were all decided without an approval (rejected)
 * goes back to finding when more may come, else it is completed.
 */
function campaignStatusWork(db: Conn, now: Date): LocalWork | null {
  const finding = db.select().from(campaigns).where(eq(campaigns.status, "finding")).orderBy(asc(campaigns.id)).all();
  for (const campaign of finding) {
    const { pending, ready } = readyCounts(db, campaign.id);
    const nothingNow = stageCount(db, campaign.id, "found") === 0 && (targetReached(db, campaign) || availableSource(db, campaign, now) === null);
    // Prospects already approved (auto-approve) wait for nobody: the campaign runs.
    const next: CampaignStatus = pending > 0 ? "awaiting_approval" : "running";
    if (ready > 0 && (ready >= campaign.batchSize || nothingNow)) {
      const why = ready >= campaign.batchSize ? "its first batch is ready" : "nothing more is left to find";
      const message =
        next === "awaiting_approval"
          ? `${campaign.name}: ${pending} prospect${pending === 1 ? "" : "s"} wait for your approval (${why})`
          : `${campaign.name} is running: ${ready} prospect${ready === 1 ? " is" : "s are"} approved (${why})`;
      return { kind: "campaign_status", campaign, from: "finding", to: next, message };
    }
    if (ready === 0 && !moreToCome(db, campaign)) {
      return { kind: "campaign_status", campaign, from: "finding", to: "completed", message: `${campaign.name} completed: nobody matched the campaign; there is nothing more to find` };
    }
  }
  const awaiting = db.select().from(campaigns).where(eq(campaigns.status, "awaiting_approval")).orderBy(asc(campaigns.id)).all();
  for (const campaign of awaiting) {
    if (readyCounts(db, campaign.id).ready > 0) continue;
    return moreToCome(db, campaign)
      ? { kind: "campaign_status", campaign, from: "awaiting_approval", to: "finding", message: `${campaign.name}: nobody is waiting for your approval; finding more people` }
      : {
          kind: "campaign_status",
          campaign,
          from: "awaiting_approval",
          to: "completed",
          message: `${campaign.name} completed: nobody is left to approve and there is nothing more to find`,
        };
  }
  return null;
}

// ---------------------------------------------------------------- what the AI is given

/** The part of a stored profile (`people.raw.profile`) that scoring reads. */
const storedProfile = z.object({
  about: z.string().nullable(),
  currentTitle: z.string().nullable(),
  currentCompany: z.string().nullable(),
  experience: z.array(
    z.object({ title: z.string(), company: z.string().nullable(), dateRange: z.string().nullable(), description: z.string().nullable() }),
  ),
});

/** Whether the stored profile showed a connection or a pending invitation. */
const storedConnection = z.object({
  connectionState: z.enum(["can_connect", "connect_in_more", "pending", "connected", "follow_only", "unknown"] as const satisfies readonly ConnectionState[]).catch("unknown"),
  degree: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable().catch(null),
});

/** What cleaning stored on `people.raw.cleaned`: the values it was given, so the raw company is kept. */
const storedCleaning = z.object({ fullName: z.string(), company: z.string().nullable() });

function rawPart<T>(raw: unknown, key: string, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(rawRecord(raw)[key]);
  return parsed.success ? parsed.data : null;
}

function cardOf(person: PersonRow): CardForScoring {
  return { publicId: person.publicId, fullName: person.fullName, headline: person.headline, location: person.location, company: person.company };
}

function profileOf(person: PersonRow): ProfileForScoring {
  const stored = rawPart(person.raw, "profile", storedProfile);
  return {
    publicId: person.publicId,
    fullName: person.fullName,
    headline: person.headline,
    location: person.location,
    about: stored?.about ?? null,
    currentTitle: stored?.currentTitle ?? person.title,
    currentCompany: stored?.currentCompany ?? person.company,
    experience: stored?.experience.map(({ title, company, dateRange, description }) => ({ title, company, dateRange, description })) ?? [],
  };
}

const isCleaned = (person: PersonRow): boolean => rawPart(person.raw, "cleaned", storedCleaning) !== null;

// ---------------------------------------------------------------- checking what the AI wrote

/** The longest first name kept from cleaning. */
export const FIRST_NAME_MAX = 40;
/** The longest company name kept from cleaning. */
export const COMPANY_MAX = 80;
/** Letters, hyphens, apostrophes and spaces only. */
const FIRST_NAME_CHARS = /^[\p{L}\p{M}'’ -]+$/u;

/** Lower case, without accents, one kind of apostrophe: how a cleaned value is compared with what LinkedIn showed. */
function plain(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/’/g, "'").toLowerCase();
}

/**
 * The cleaned first name when it is one of the words of the full name LinkedIn showed (or several
 * of them, in order), else null: the AI may pick a name out, never write one.
 */
export function checkedFirstName(cleaned: string | null, fullName: string): string | null {
  const value = cleaned?.trim() ?? "";
  if (value === "" || value.length > FIRST_NAME_MAX || !FIRST_NAME_CHARS.test(value)) return null;
  const wanted = plain(value).split(" ");
  const words = plain(fullName).match(/[\p{L}'-]+/gu) ?? [];
  for (let i = 0; i + wanted.length <= words.length; i++) {
    if (wanted.every((word, j) => words[i + j] === word)) return value;
  }
  return null;
}

/**
 * The cleaned company name when every word of it is in the company text LinkedIn showed, else null
 * (the shown text is then kept): the AI may shorten a company name, never add to it.
 */
export function checkedCompany(cleaned: string | null, shown: string | null): string | null {
  const value = cleaned?.trim() ?? "";
  if (value === "" || shown === null || value.length > COMPANY_MAX || /\p{Cc}/u.test(value)) return null;
  const words = plain(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  const shownWords = new Set(plain(shown).match(/[\p{L}\p{N}]+/gu) ?? []);
  return words.length > 0 && words.every((word) => shownWords.has(word)) ? value : null;
}

// ---------------------------------------------------------------- running it

/**
 * Does one piece of local work and returns a few words for the log. An AI call is made before
 * anything is written, so when it throws (`AiUnavailable` or a bug) nothing has changed.
 */
export async function runLocalWork(ctx: ScoringContext, ai: Ai | null, work: LocalWork): Promise<string> {
  const { db, clock } = ctx;
  switch (work.kind) {
    case "reject_card": {
      const { target } = work;
      const at = clock.now();
      const cardScore = target.prospect.cardScore;
      db.transaction((tx) =>
        rejectFound(tx, target, { score: cardScore, scoreReason: "the card scored below the campaign's open-profile threshold" }, at, `${target.person.fullName} rejected: the card scored below the campaign's open-profile threshold`),
      );
      return `scoring: ${target.person.fullName} rejected on the card`;
    }
    case "campaign_status": {
      const at = clock.now();
      db.transaction((tx) => {
        // Leaving `awaiting_approval` only while still nobody waits for approval or is approved.
        if (work.from === "awaiting_approval" && readyCounts(tx, work.campaign.id).ready > 0) return;
        const changed = tx
          .update(campaigns)
          .set({ status: work.to, updatedAt: at })
          .where(and(eq(campaigns.id, work.campaign.id), eq(campaigns.status, work.from)))
          .run().changes;
        if (changed === 1) logEvent(tx, { campaignId: work.campaign.id, message: work.message }, at);
      });
      return `campaign: ${work.campaign.name} ${work.to.replace(/_/g, " ")}`;
    }
    case "score_cards":
      return scoreCards(ctx, needAi(ai), work.campaign, work.targets);
    case "score_profile":
      return scoreProfile(ctx, needAi(ai), work.target);
    default: {
      const _exhaustive: never = work;
      throw new Error(`unknown local work ${String(_exhaustive)}`);
    }
  }
}

function needAi(ai: Ai | null): Ai {
  if (ai === null) throw new Error("AI work was picked without an AI");
  return ai;
}

async function scoreCards(ctx: ScoringContext, ai: Ai, campaign: CampaignRow, targets: readonly Target[]): Promise<string> {
  const { db, clock } = ctx;
  const answer = await ai.scoreCards(campaign.scoringBrief, targets.map((target) => cardOf(target.person)));
  // The contract is one score per card. Without this, a card left out would be sent again every second.
  const missing = targets.find((target) => !answer.value.some((s) => s.publicId === target.person.publicId));
  if (missing !== undefined) throw new Error(`the AI gave no score for the card of prospect ${missing.prospect.id}`);
  const at = clock.now();
  let rejected = 0;
  db.transaction((tx) => {
    const current = tx.select().from(campaigns).where(eq(campaigns.id, campaign.id)).get() ?? campaign;
    for (const target of targets) {
      const scored = answer.value.find((s) => s.publicId === target.person.publicId);
      if (scored === undefined) throw new Error(`the AI gave no score for the card of prospect ${target.prospect.id}`);
      const stored = tx
        .update(prospects)
        .set({ cardScore: scored.score })
        .where(and(eq(prospects.id, target.prospect.id), eq(prospects.stage, "found"), isNull(prospects.cardScore)))
        .run().changes;
      if (stored !== 1 || scored.score >= current.openProfileThreshold) continue;
      const changes = { score: scored.score, scoreReason: scored.reason, scoreModel: answer.model };
      if (rejectFound(tx, target, changes, at, `${target.person.fullName} rejected on the card (score ${scored.score}): ${scored.reason}`)) rejected += 1;
    }
  });
  return `scoring: ${targets.length} card${targets.length === 1 ? "" : "s"} of ${campaign.name} scored, ${rejected} rejected`;
}

/**
 * One AI call of a viewed prospect's scoring, whichever is next: the profile score (a score below
 * the campaign's threshold rejects it), the cleaned variables, then the personal line when the
 * campaign asks for one. The call that is last for this prospect also moves it on.
 */
async function scoreProfile(ctx: ScoringContext, ai: Ai, target: Target): Promise<string> {
  const { db, clock } = ctx;
  const { prospect, campaign, person } = target;
  const name = person.fullName;

  if (prospect.score === null) {
    // A person found again whose profile was opened for an earlier campaign is not opened again, so
    // what that profile showed still rules them out: no AI, no approval queue.
    const shown = rawPart(person.raw, "profile", storedConnection);
    const why = shown === null ? null : ruledOut(shown);
    if (why !== null) {
      const at = clock.now();
      db.transaction((tx) => rejectFound(tx, target, { scoreReason: why }, at, `${name} rejected: ${why} (as the profile showed when it was opened)`));
      return `scoring: ${name} rejected (${why})`;
    }
    const answer = await ai.scoreProfile(campaign.scoringBrief, profileOf(person));
    const { score, reason, industry, size } = answer.value;
    const at = clock.now();
    const outcome = db.transaction((tx) => {
      const stored = tx
        .update(prospects)
        .set({ score, scoreReason: reason, scoreModel: answer.model })
        .where(and(eq(prospects.id, prospect.id), eq(prospects.stage, "found"), isNull(prospects.score)))
        .run().changes;
      if (stored !== 1) return "changed meanwhile; left as it is";
      tx.update(people).set({ industryEvidence: industry, sizeEvidence: size }).where(eq(people.id, person.id)).run();
      const threshold = currentCampaign(tx, campaign).scoreThreshold;
      if (score >= threshold) return `scored ${score}`;
      rejectScored(tx, target, at, `${name} rejected (score ${score}, below ${threshold}): ${reason}`);
      return `rejected (score ${score})`;
    });
    return `scoring: ${name} ${outcome}`;
  }

  if (!isCleaned(person)) {
    const given = { fullName: person.fullName, company: person.company };
    const answer = await ai.cleanVariables(given);
    const at = clock.now();
    db.transaction((tx) => {
      const stored = tx.select().from(people).where(eq(people.id, person.id)).get() ?? person;
      tx.update(people)
        .set({
          firstName: checkedFirstName(answer.value.firstName, stored.fullName),
          company: checkedCompany(answer.value.companyShort, given.company) ?? stored.company,
          raw: { ...rawRecord(stored.raw), cleaned: { ...given, ...answer.value, model: answer.model } },
        })
        .where(eq(people.id, person.id))
        .run();
      if (!wantsLine(currentCampaign(tx, campaign), prospect.score)) decide(tx, target, at);
    });
    return `scoring: variables of ${name} cleaned`;
  }

  if (wantsLine(campaign, prospect.score)) {
    const answer = await ai.personalise({ profile: profileOf(person), industry: person.industryEvidence, instructions: campaign.personalisationInstructions ?? "" });
    // The line only with the profile text it rests on: neither is stored when either is missing.
    const kept = answer.value !== null && answer.value.line.trim() !== "" && answer.value.evidence.trim() !== "" ? answer.value : null;
    const at = clock.now();
    db.transaction((tx) => {
      tx.update(prospects)
        .set({ aiLine: kept?.line ?? null, aiLineEvidence: kept?.evidence ?? null })
        .where(and(eq(prospects.id, prospect.id), eq(prospects.stage, "found")))
        .run();
      decide(tx, target, at);
    });
    return `scoring: personal line for ${name} ${kept === null ? "not written (nothing to rest it on)" : "written"}`;
  }

  const at = clock.now();
  db.transaction((tx) => decide(tx, target, at));
  return `scoring: ${name} decided`;
}

function currentCampaign(db: Conn, campaign: CampaignRow): CampaignRow {
  return db.select().from(campaigns).where(eq(campaigns.id, campaign.id)).get() ?? campaign;
}

/** The campaign asks for a personal line and the score earns one. */
function wantsLine(campaign: CampaignRow, score: number | null): boolean {
  return campaign.aiPersonalise && score !== null && score >= campaign.scoreThreshold;
}

/** Closes a found prospect scored on its profile as rejected: `found → scored → rejected`. */
function rejectScored(db: Conn, target: Target, at: Date, message: string): void {
  if (!move(db, target, "scored", {}, at, null)) return;
  const scored: Target = { ...target, prospect: { ...target.prospect, stage: "scored" } };
  move(db, scored, "rejected", { closedAt: at, nextActionAt: null }, at, message);
}

/**
 * Moves a fully scored prospect on, against the campaign as it is now: `scored`, then the approval
 * queue (or approved, when the campaign approves by itself) at or above the threshold, else rejected.
 */
function decide(db: Conn, target: Target, at: Date): void {
  const campaign = currentCampaign(db, target.campaign);
  const row = db.select({ score: prospects.score }).from(prospects).where(eq(prospects.id, target.prospect.id)).get();
  const score = row?.score ?? null;
  const name = target.person.fullName;
  if (score === null || score < campaign.scoreThreshold) {
    rejectScored(db, target, at, `${name} rejected (score ${score ?? "none"}, below ${campaign.scoreThreshold})`);
    return;
  }
  if (!move(db, target, "scored", {}, at, null)) return;
  const scored: Target = { ...target, prospect: { ...target.prospect, stage: "scored" } };
  if (campaign.autoApprove) {
    move(db, scored, "approved", { approvedAt: at }, at, `${name} approved automatically (score ${score})`);
  } else {
    move(db, scored, "pending_approval", {}, at, `${name} waits for your approval (score ${score})`);
  }
}
