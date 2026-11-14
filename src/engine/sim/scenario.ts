/**
 * The three-week scenario the engine simulation runs (handoff section 5, item 2). It starts on
 * Monday 2027-03-15 08:00 Europe/Rome so the run crosses the daylight-saving change of 2027-03-28,
 * and ends on Monday 2027-04-05 08:00; the third week is a drain week with no new prospects.
 *
 * The calendar: LinkedIn refuses the app's fourth invitation on the first morning (`HAND_SENT`);
 * the laptop opens only at 17:45 on 03-16 and 03-19 (reads slept through, `LATE_OPENING_DAYS`);
 * it is off from 03-23 to 03-25 but for three short openings, each ending in a send slept through
 * (`SLEEP_OPENINGS`), so 03-26 is a full working day after downtime; the weekly invite limit
 * (`WEEKLY_INVITE_LIMIT`) ends invites on 03-30; LinkedIn shows a checkpoint on 03-31; the laptop
 * sleeps through the night to 04-02 10:30, the quiet last day.
 *
 * Discovery (`DISCOVERY_DAY`): from 03-17 campaigns G (recommendations) and H (a two-page search)
 * start in finding and are scored by the fake AI; 03-18 reaches the profile-view and discovery-page
 * limits; H's second page meets LinkedIn's search cap; from 03-30 campaign K takes new suggestions
 * while the AI is out until the checkpoint's safety stop. The simulated user approves each queue
 * three hours after he first sees it waiting (`approvalQueueUser`), through the app's `approveAll`.
 *
 * Rows of the outreach campaigns are inserted directly with Drizzle, as the approval queue would
 * leave them; the discovery campaigns' prospects are the engine's own. Every member is synthetic:
 * "<invented first name> Sample<NNN>" at "Example Works <NNN>", or "Dott. Sample <NNN>" with no
 * first name for the two members no template can greet.
 *
 * The helpers at the top are also what the tests' small scenarios are built from.
 */
import { and, count, eq, inArray, notInArray } from "drizzle-orm";
import { pauseCampaign, resumeCampaign } from "../../campaigns/campaigns";
import { approveAll } from "../../campaigns/prospects";
import { DEFAULT_SETTINGS, setSettings, type SettingsPatch } from "../../config/settings";
import type { Db } from "../../db/index";
import { actions, campaigns, CLOSED_STAGES, people, prospects, type CampaignStatus, type DelayPolicy, type ProspectStage } from "../../db/schema";
import type { DriverOp, FaultKind, MemberSpec, RecommendationGroupSpec } from "../../linkedin/fake/world";
import { profileUrlFor } from "../../linkedin/parse/card";
import type { RandomSource } from "../ports";
import {
  mulberry32,
  randomBetween,
  type CampaignFact,
  type DiscoveredFact,
  type DiscoveredKind,
  type DiscoveryCampaignFact,
  type DiscoveryPlan,
  type Downtime,
  type Expectation,
  type ForcedKill,
  type Intervention,
  type MemberFact,
  type Minimums,
  type Scenario,
  type ScenarioEvent,
  type ScenarioFacts,
  type ScheduledFault,
  type SimContext,
  type SuspensionPlan,
} from "./harness";
import { addDays, isWorkingDay, localDay, localInstant, windowOn } from "./localTime";

export const TIME_ZONE = "Europe/Rome";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A local wall-clock instant in Rome. */
export function rome(day: string, hour: number, minute = 0): Date {
  return localInstant(TIME_ZONE, day, hour, minute);
}

// ---------------------------------------------------------------- building blocks

export interface CampaignSpec {
  readonly key: string;
  readonly inviteNote: string | null;
  readonly firstMessage: string;
  readonly followUp: string;
  readonly delayPolicy?: DelayPolicy;
  readonly withdrawAfterDays?: number;
  /** Default running; a discovery campaign always starts in finding. */
  readonly status?: "running" | "paused";
  /** The campaign finds its own prospects from this source (a search needs `searchUrl`). */
  readonly discovery?: DiscoveryCampaignFact & { readonly searchUrl?: string };
}

export function emptyFacts(): ScenarioFacts {
  return { settings: DEFAULT_SETTINGS, settingsHistory: [], campaigns: new Map(), members: new Map(), discoveryLog: [] };
}

/** The user changes settings: stored in the app, and remembered with the time for the verdicts. */
export function applySettings(context: SimContext, patch: SettingsPatch): void {
  const settings = setSettings(context.db, patch, context.now);
  context.facts.settings = settings;
  context.facts.settingsHistory.push({ at: context.now, settings });
}

export function createCampaign({ db, now, facts }: SimContext, spec: CampaignSpec): CampaignFact {
  const discovery = spec.discovery;
  const row = db
    .insert(campaigns)
    .values({
      name: `Campaign ${spec.key}`,
      status: discovery === undefined ? (spec.status ?? "running") : "finding",
      discoverySource: discovery?.source ?? "search",
      sourceUrls: discovery?.searchUrl === undefined ? [] : [discovery.searchUrl],
      scoringBrief: discovery?.brief ?? "Simulated campaign",
      ...(discovery === undefined
        ? {}
        : { openProfileThreshold: discovery.openProfileThreshold, scoreThreshold: discovery.scoreThreshold, batchSize: discovery.batchSize }),
      inviteNote: spec.inviteNote,
      firstMessage: spec.firstMessage,
      followUp: spec.followUp,
      delayPolicy: spec.delayPolicy ?? "calendar",
      withdrawAfterDays: spec.withdrawAfterDays ?? 21,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: campaigns.id })
    .get();
  const fact: CampaignFact = {
    key: spec.key,
    id: row.id,
    inviteNote: spec.inviteNote,
    firstMessage: spec.firstMessage,
    followUp: spec.followUp,
    ...(discovery === undefined
      ? {}
      : {
          discovery: {
            source: discovery.source,
            brief: discovery.brief,
            openProfileThreshold: discovery.openProfileThreshold,
            scoreThreshold: discovery.scoreThreshold,
            batchSize: discovery.batchSize,
          },
        }),
  };
  facts.campaigns.set(spec.key, fact);
  return fact;
}

export function setCampaignStatus({ db, now, facts }: SimContext, key: string, status: "running" | "paused"): void {
  const campaign = facts.campaigns.get(key);
  if (campaign === undefined) throw new RangeError(`no campaign ${key}`);
  db.update(campaigns).set({ status, updatedAt: now }).where(eq(campaigns.id, campaign.id)).run();
}

/** The user rejects (or stops) a member's first prospect from the dashboard, as its stage change would be written. */
export function closeByUser({ db, now, facts }: SimContext, publicId: string, to: "rejected" | "stopped"): void {
  const prospect = facts.members.get(publicId)?.prospects[0];
  if (prospect === undefined) throw new RangeError(`no prospect for ${publicId}`);
  // A stop by the user is neither a reply nor a takeover the app saw: no stop reason.
  db.update(prospects).set({ stage: to, stopReason: null, closedAt: now, nextActionAt: null }).where(eq(prospects.id, prospect.prospectId)).run();
}

/** A reply the scripted member writes while the app is about to send. */
export const MID_SEND_REPLY = "Thanks, I was just about to write to you. Happy to talk.";

/** Interventions that make a member reply between the app's thread read and its send (at `sendMessage`/`before`). */
export function replyMidSend(target: string): Intervention {
  return { label: "reply lands between the thread read and the send", op: "sendMessage", target, apply: ({ world, now }) => world.writeAsMember(target, MID_SEND_REPLY, now) };
}

/** Every message send to `target` fails before its effect. */
export function sendNeverSucceeds(target: string): Intervention {
  return { label: "message send times out before its effect", op: "sendMessage", target, every: true, apply: ({ world }) => world.failNext("sendMessage", "timeout_before_effect") };
}

/** While a read about `target` loads (its thread, unless told), the user pauses its campaign; he resumes it `resumeAfterMs` later. */
export function pauseMidRead(target: string, campaign: string, resumeAfterMs: number, op: "viewProfile" | "readThread" = "readThread"): Intervention {
  return {
    label: `campaign ${campaign} paused while a read loads`,
    op,
    target,
    apply: (context) => {
      setCampaignStatus(context, campaign, "paused");
      context.later(resumeAfterMs, `campaign ${campaign} resumed`, (later) => setCampaignStatus(later, campaign, "running"));
    },
  };
}

/** While a read about `target` loads, the user rejects or stops their prospect. */
export function closeMidRead(target: string, op: "viewProfile" | "readThread", to: "rejected" | "stopped"): Intervention {
  return { label: `prospect ${to} by the user while a read loads`, op, target, apply: (context) => closeByUser(context, target, to) };
}

/** The user edits a campaign's follow-up text (blank: no follow-up). */
export function setFollowUp({ db, now, facts }: SimContext, key: string, followUp: string): void {
  const campaign = facts.campaigns.get(key);
  if (campaign === undefined) throw new RangeError(`no campaign ${key}`);
  db.update(campaigns).set({ followUp, updatedAt: now }).where(eq(campaigns.id, campaign.id)).run();
}

/** Messages LinkedIn received from the app so far on the local calendar day of `now`. */
export function messagesSentToday({ world, now, facts }: SimContext): number {
  const today = localDay(facts.settings.timeZone, now);
  return world.log.filter((entry) => entry.kind === "message" && localDay(facts.settings.timeZone, entry.at) === today).length;
}

/** Ms from `now` to 08:00 local on the next calendar day. */
export function untilNextMorning({ now, facts }: SimContext): number {
  const tomorrow = addDays(localDay(facts.settings.timeZone, now), 1);
  return localInstant(facts.settings.timeZone, tomorrow, 8).getTime() - now.getTime();
}

/**
 * While the thread before `target`'s first message loads, the user lowers the daily message limit to
 * the number already sent today: no further message may go out today. He puts it back the next morning.
 */
export function lowerMessageLimitMidRead(target: string): Intervention {
  return {
    label: "daily message limit lowered to today's count while a thread loads",
    tag: "settings_mid_read",
    op: "readThread",
    target,
    when: ({ world }) => world.messagesSentTo(target).length === 0,
    apply: (context) => {
      const before = context.facts.settings.limits.messagesPerDay;
      applySettings(context, { limits: { messagesPerDay: messagesSentToday(context) } });
      context.later(untilNextMorning(context), "daily message limit restored", (later) => applySettings(later, { limits: { messagesPerDay: before } }));
    },
  };
}

/**
 * While the thread before `target`'s follow-up loads, the user clears the campaign's follow-up text;
 * he restores it `restoreAfterMs` later.
 */
export function clearFollowUpMidRead(target: string, campaign: string, restoreAfterMs: number): Intervention {
  return {
    label: `campaign ${campaign}'s follow-up cleared while a thread loads`,
    tag: "settings_mid_read",
    op: "readThread",
    target,
    when: ({ world }) => world.messagesSentTo(target).length >= 1,
    apply: (context) => {
      const text = context.facts.campaigns.get(campaign)?.followUp;
      if (text === undefined) throw new RangeError(`no campaign ${campaign}`);
      setFollowUp(context, campaign, "");
      context.later(restoreAfterMs, `campaign ${campaign}'s follow-up restored`, (later) => setFollowUp(later, campaign, text));
    },
  };
}

/** One person row, as discovery would store it. */
export interface PersonRow {
  readonly publicId: string;
  /** Usually unknown until the engine views the profile. */
  readonly memberId?: string | null;
  readonly fullName: string;
  readonly firstName: string | null;
  readonly company: string | null;
  readonly degree?: 1 | 2 | 3;
  readonly doNotContact?: boolean;
  /** As an earlier discovery stored them; default an operations lead in Milan. */
  readonly headline?: string;
  readonly location?: string;
  readonly title?: string;
}

export function insertPerson(db: Db, row: PersonRow, now: Date): number {
  return db
    .insert(people)
    .values({
      publicId: row.publicId,
      memberId: row.memberId ?? null,
      profileUrl: profileUrlFor(row.publicId),
      fullName: row.fullName,
      firstName: row.firstName,
      headline: row.headline ?? "Operations lead",
      title: row.title ?? "Head of Operations",
      company: row.company,
      location: row.location ?? "Milan, Italy",
      connectionDegree: row.degree ?? 2,
      discoverySource: "search",
      firstSeenAt: now,
      doNotContact: row.doNotContact ?? false,
    })
    .returning({ id: people.id })
    .get().id;
}

/** An approved prospect, due now, as the approval queue leaves it. */
export function insertApprovedProspect(db: Db, campaignId: number, personId: number, now: Date): number {
  return db
    .insert(prospects)
    .values({
      campaignId,
      personId,
      score: 8,
      scoreReason: "simulated",
      scoreModel: "simulation",
      stage: "approved",
      nextActionAt: now,
      foundAt: now,
      approvedAt: now,
    })
    .returning({ id: prospects.id })
    .get().id;
}

function memberFact(facts: ScenarioFacts, spec: MemberSpec, role: string, scripted: boolean, expect: Expectation | null, discovered?: DiscoveredFact): MemberFact {
  let fact = facts.members.get(spec.publicId);
  if (fact === undefined) {
    fact = {
      publicId: spec.publicId,
      memberId: spec.memberId,
      role,
      prospects: [],
      preRunInvites: 0,
      trapSince: null,
      doNotContact: false,
      scripted,
      expect,
      ...(discovered === undefined ? {} : { discovered }),
    };
    facts.members.set(spec.publicId, fact);
  }
  return fact;
}

export interface Enrolment {
  readonly campaign: string;
  /** The world member (added to the world unless `inWorld` is true). */
  readonly member: MemberSpec;
  readonly role: string;
  readonly firstName: string | null;
  readonly company: string | null;
  /** The people row, when it differs from the world member (the shared-member-id trap). */
  readonly person?: Partial<PersonRow>;
  readonly inWorld?: boolean;
  /** Shielded from random kills and faults (see `MemberFact.scripted`). */
  readonly scripted?: boolean;
  readonly expect?: Expectation;
  /** A discovery source also shows them. */
  readonly discovered?: DiscoveredFact;
}

/** Adds a member to the world, a person row and an approved prospect, and remembers it all in the facts. */
export function enrol(context: SimContext, enrolment: Enrolment): number {
  const { db, world, now, facts } = context;
  const campaign = facts.campaigns.get(enrolment.campaign);
  if (campaign === undefined) throw new RangeError(`no campaign ${enrolment.campaign}`);
  if (enrolment.inWorld !== true) world.addMember(enrolment.member);
  const personPublicId = enrolment.person?.publicId ?? enrolment.member.publicId;
  const doNotContact = enrolment.person?.doNotContact ?? false;
  const personId = insertPerson(
    db,
    {
      publicId: personPublicId,
      memberId: enrolment.person?.memberId ?? null,
      fullName: enrolment.member.fullName,
      firstName: enrolment.firstName,
      company: enrolment.company,
      degree: enrolment.member.degree,
      doNotContact,
    },
    now,
  );
  const prospectId = insertApprovedProspect(db, campaign.id, personId, now);
  const fact = memberFact(facts, enrolment.member, enrolment.role, enrolment.scripted ?? false, enrolment.expect ?? null, enrolment.discovered);
  fact.doNotContact ||= doNotContact;
  fact.prospects.push({ campaign: enrolment.campaign, prospectId, personPublicId, firstName: enrolment.firstName, company: enrolment.company, addedAt: now });
  return prospectId;
}

/** A new approved prospect for a person who already has a row (a suppression trap). */
export function enrolExisting(context: SimContext, campaignKey: string, personId: number, worldPublicId: string): void {
  const { db, now, facts } = context;
  const campaign = facts.campaigns.get(campaignKey);
  const fact = facts.members.get(worldPublicId);
  const person = db.select().from(people).where(eq(people.id, personId)).get();
  if (campaign === undefined || fact === undefined || person === undefined) throw new RangeError(`cannot re-enrol ${worldPublicId}`);
  const prospectId = insertApprovedProspect(db, campaign.id, personId, now);
  fact.prospects.push({ campaign: campaignKey, prospectId, personPublicId: person.publicId, firstName: person.firstName, company: person.company, addedAt: now });
}

// ---------------------------------------------------------------- synthetic members

const FIRST_NAMES = ["Arlo", "Bria", "Cato", "Dela", "Enzo", "Fia", "Gael", "Hana", "Ivo", "Juna", "Kai", "Lior", "Mira", "Nilo", "Oda", "Pia", "Remo", "Sela", "Tito", "Uma", "Vito", "Wren", "Yara", "Zeno"];

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export interface Synthetic {
  readonly spec: MemberSpec;
  readonly firstName: string;
  readonly company: string;
}

export function synthetic(n: number, extra: Partial<MemberSpec> = {}): Synthetic {
  const firstName = FIRST_NAMES[n % FIRST_NAMES.length] ?? "Arlo";
  const company = `Example Works ${pad3(n)}`;
  return {
    firstName,
    company,
    spec: {
      publicId: `sim-member-${pad3(n)}`,
      memberId: `ACoASimMember${pad3(n)}`,
      fullName: `${firstName} Sample${pad3(n)}`,
      headline: "Operations lead",
      location: "Milan, Italy",
      currentTitle: "Head of Operations",
      currentCompany: company,
      degree: 2,
      ...extra,
    },
  };
}

/** A regular member's script: most accept after 2–100 h, some never; some reply, write first, or are written to by the user. */
function regularBehaviour(random: RandomSource): { role: string; extra: Partial<MemberSpec> } {
  if (random() < 0.3) return { role: "never_accepts", extra: { acceptsAfterHours: null } };
  const acceptsAfterHours = randomBetween(random, 2, 100);
  const pick = random();
  if (pick < 0.2) return { role: "replies_after_first", extra: { acceptsAfterHours, repliesAfterHours: randomBetween(random, 1, 48) } };
  if (pick < 0.28) return { role: "writes_first", extra: { acceptsAfterHours, repliesBeforeFirstMessageAfterHours: randomBetween(random, 1, 30) } };
  if (pick < 0.36) return { role: "user_writes", extra: { acceptsAfterHours, userWritesAfterHours: randomBetween(random, 1, 40) } };
  if (pick < 0.41) return { role: "user_resends", extra: { acceptsAfterHours, userResendsAfterHours: randomBetween(random, 2, 30) } };
  return { role: "silent", extra: { acceptsAfterHours } };
}

// ---------------------------------------------------------------- discovery building blocks

/**
 * The scoring brief of every discovery campaign here. The fake AI (`src/ai/fakeAi.ts`) gives 3
 * points for each of its words of four letters or more found in the person's text, capped at 10:
 * here "head", "operations", "logistics", "firm" and "turin".
 */
export const DISCOVERY_BRIEF = "Head of operations at a logistics firm in Turin";
export const OPEN_PROFILE_THRESHOLD = 6;
export const SCORE_THRESHOLD = 7;

/**
 * What a discovered member's card and profile say, named by where the fake AI puts them under
 * `DISCOVERY_BRIEF` (card = headline, location, company; profile = those, the title and the job):
 * - `low`: card 0, below the open-profile threshold; `low3`: card 3 (Turin only), below it too;
 * - `mid`: card 6, between the thresholds, so the profile is opened; profile 6, rejected;
 * - `mid_up`: card 6, profile 10 (the title adds "head" and "logistics"): waits for approval;
 * - `high`: card 9, above the score threshold; profile 9: waits for approval.
 */
export type CardKind = "low" | "low3" | "mid" | "mid_up" | "high";

const CARD_TEXT: Readonly<Record<CardKind, { readonly headline: string; readonly location: string; readonly title: string }>> = {
  low: { headline: "Graphic designer", location: "Naples, Italy", title: "Graphic designer" },
  low3: { headline: "Graphic designer", location: "Turin, Italy", title: "Graphic designer" },
  mid: { headline: "Operations coordinator", location: "Turin, Italy", title: "Operations coordinator" },
  mid_up: { headline: "Operations coordinator", location: "Turin, Italy", title: "Head of logistics" },
  high: { headline: "Head of operations", location: "Turin, Italy", title: "Head of operations" },
};

export interface DiscoveredSpec {
  readonly n: number;
  readonly card: CardKind;
  readonly kind: DiscoveredKind;
  /** The discovery campaigns whose source shows them. */
  readonly campaigns: readonly string[];
  /** What they do once invited (a regular member's script); `kind` adds its own. */
  readonly extra?: Partial<MemberSpec>;
  /** For `active_elsewhere`: the campaign holding their active prospect (default A). For `contacted_before`: where they were contacted (default A). */
  readonly elsewhere?: string;
  /** Shielded from random kills and scripted faults (`MemberFact.scripted`): a forced kill's target. */
  readonly scripted?: boolean;
}

/**
 * Adds a member a discovery source shows, as `kind` says: in the world (with a card that scores as
 * `card` says), and for the excluded kinds the row or prospect that excludes them. Returns the fact.
 */
export function addDiscovered(context: SimContext, spec: DiscoveredSpec): MemberFact {
  const { db, world, now, facts } = context;
  const text = CARD_TEXT[spec.card];
  const longAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const byKind: Partial<MemberSpec> =
    spec.kind === "first_degree"
      ? { degree: 1, connectedAt: longAgo(40), acceptsAfterHours: null }
      : spec.kind === "pending_invite"
        ? // Sent more than a week before the run: LinkedIn's weekly cap no longer counts it (`HAND_SENT` fills that).
          { invitedOutsideApp: true, invitedAt: longAgo(10), acceptsAfterHours: null }
        : {};
  const member = synthetic(spec.n, { headline: text.headline, location: text.location, currentTitle: text.title, ...spec.extra, ...byKind });
  const discovered: DiscoveredFact = {
    kind: spec.kind,
    campaigns: spec.campaigns,
    card: { publicId: member.spec.publicId, fullName: member.spec.fullName, headline: text.headline, location: text.location, company: member.company },
    cardScores: new Map(),
  };
  const role = `discovered_${spec.kind === "regular" ? spec.card : spec.kind}`;
  // A row stored before discovery shows the person as their card does: an app scoring it scores the card.
  const asShown = { headline: text.headline, location: text.location, title: text.title };
  if (spec.kind === "active_elsewhere") {
    enrol(context, { campaign: spec.elsewhere ?? "A", member: member.spec, role, firstName: member.firstName, company: member.company, discovered, person: asShown });
    return facts.members.get(member.spec.publicId) ?? memberFact(facts, member.spec, role, false, null, discovered);
  }
  world.addMember(member.spec);
  const fact = memberFact(facts, member.spec, role, spec.scripted ?? false, null, discovered);
  if (spec.kind === "do_not_contact") {
    insertPerson(db, { publicId: member.spec.publicId, fullName: member.spec.fullName, firstName: member.firstName, company: member.company, doNotContact: true, ...asShown }, now);
    fact.doNotContact = true;
  }
  if (spec.kind === "contacted_before") {
    const campaignId = facts.campaigns.get(spec.elsewhere ?? "A")?.id;
    if (campaignId === undefined) throw new RangeError(`no campaign ${spec.elsewhere ?? "A"}`);
    const personId = insertPerson(db, { publicId: member.spec.publicId, memberId: member.spec.memberId, fullName: member.spec.fullName, firstName: member.firstName, company: member.company, ...asShown }, now);
    closedBeforeRun(db, campaignId, personId, "withdrawn", now);
    fact.preRunInvites = 1;
    fact.trapSince = now;
  }
  return fact;
}

/** My Network → Grow as two groups that share one person (LinkedIn repeats people across groups). */
export function recommendationGroups(publicIds: readonly string[]): RecommendationGroupSpec[] {
  const half = Math.ceil(publicIds.length / 2);
  return [
    { title: "People you may know in Turin", publicIds: publicIds.slice(0, half + 1) },
    { title: "People in logistics", publicIds: publicIds.slice(half) },
  ];
}

/** The campaign's status, or the one it returns to when it is paused. */
function workingStatus(row: { readonly status: CampaignStatus; readonly pausedFrom: CampaignStatus | null }): CampaignStatus {
  return row.status === "paused" ? (row.pausedFrom ?? "paused") : row.status;
}

function stageCount(db: Db, campaignId: number, stages: readonly ProspectStage[]): number {
  return db
    .select({ n: count() })
    .from(prospects)
    .where(and(eq(prospects.campaignId, campaignId), inArray(prospects.stage, [...stages])))
    .get()?.n ?? 0;
}

/**
 * The simulated user's look at the approval queue, as one function to call at each of his
 * check-ins. A discovery campaign's first batch is approved once it has been seen awaiting
 * approval for `waitMs`; later prospects waiting for approval once seen waiting for `waitMs`. He
 * approves them all through the app's own `approveAll`, which moves each to approved and the
 * campaign to running, and the facts learn each approved prospect's name and company as rendered.
 */
export function approvalQueueUser(waitMs: number): (context: SimContext) => void {
  const waitingSince = new Map<string, Date>();
  return (context) => {
    const { db, now, facts } = context;
    for (const campaign of facts.campaigns.values()) {
      const discovery = campaign.discovery;
      if (discovery === undefined) continue;
      const row = db.select({ status: campaigns.status, pausedFrom: campaigns.pausedFrom }).from(campaigns).where(eq(campaigns.id, campaign.id)).get();
      if (row === undefined) continue;
      const status = workingStatus(row);
      const pending = stageCount(db, campaign.id, ["pending_approval"]);
      const waiting = status === "awaiting_approval" || (status === "running" && pending > 0);
      if (!waiting) {
        waitingSince.delete(campaign.key);
        continue;
      }
      const since = waitingSince.get(campaign.key);
      if (since === undefined) {
        waitingSince.set(campaign.key, now);
        if (status === "awaiting_approval") facts.discoveryLog.push({ kind: "awaiting_seen", at: now, campaign: campaign.key });
        continue;
      }
      if (now.getTime() - since.getTime() < waitMs) continue;
      const lineBefore = stageCount(db, campaign.id, ["found", "pending_approval"]);
      const outcome = approveAll(db, { campaignId: campaign.id, minScore: null }, now);
      if (!outcome.ok) throw new Error(`the user could not approve campaign ${campaign.key}'s queue`);
      waitingSince.delete(campaign.key);
      facts.discoveryLog.push({ kind: "approved", at: now, campaign: campaign.key, approved: outcome.value.approved, lineBefore, batchSize: discovery.batchSize });
      const approved = db
        .select({ prospectId: prospects.id, publicId: people.publicId, firstName: people.firstName, company: people.company })
        .from(prospects)
        .innerJoin(people, eq(people.id, prospects.personId))
        .where(and(eq(prospects.campaignId, campaign.id), eq(prospects.stage, "approved"), eq(prospects.approvedAt, now)))
        .all();
      for (const one of approved) {
        facts.members.get(one.publicId)?.prospects.push({
          campaign: campaign.key,
          prospectId: one.prospectId,
          personPublicId: one.publicId,
          firstName: one.firstName,
          company: one.company,
          addedAt: now,
        });
      }
    }
  };
}

/** The user pauses a discovery campaign through the app (it remembers where it was); a campaign that cannot be paused is left alone. */
export function pauseDiscovery(context: SimContext, key: string): void {
  const campaign = context.facts.campaigns.get(key);
  if (campaign === undefined) throw new RangeError(`no campaign ${key}`);
  pauseCampaign(context.db, campaign.id, context.now);
}

/** The user resumes a campaign he paused (back to finding, awaiting approval or running). */
export function resumeDiscovery(context: SimContext, key: string): void {
  const campaign = context.facts.campaigns.get(key);
  if (campaign === undefined) throw new RangeError(`no campaign ${key}`);
  const row = context.db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, campaign.id)).get();
  if (row?.status === "paused") resumeCampaign(context.db, campaign.id, context.now);
}

/** Recommendation-page rows the app has claimed for a campaign so far (the load now starting included). */
export function recommendationLoadsOf({ db, facts }: SimContext, key: string): number {
  const campaign = facts.campaigns.get(key);
  if (campaign === undefined) return 0;
  return db.select({ n: count() }).from(actions).where(and(eq(actions.campaignId, campaign.id), eq(actions.type, "recommendation_page"))).get()?.n ?? 0;
}

/**
 * While a recommendations page of `campaign` loads (its `nth` load), the user pauses the campaign;
 * he resumes it at `resumeHour`:30 local the same evening. The cards of that load are stored while
 * it is paused and scored when it resumes, after the window: AI work at night. Shielded, so no
 * random kill takes the load away.
 */
export function pauseDuringLoad(campaign: string, nth: number, resumeHour: number): Intervention {
  return {
    label: `campaign ${campaign} paused while a recommendations page loads, resumed in the evening`,
    op: "listRecommendations",
    target: null,
    shield: true,
    when: (context) => recommendationLoadsOf(context, campaign) >= nth,
    apply: (context) => {
      pauseDiscovery(context, campaign);
      const evening = localInstant(context.facts.settings.timeZone, localDay(context.facts.settings.timeZone, context.now), resumeHour, 30);
      context.later(evening.getTime() - context.now.getTime(), `campaign ${campaign} resumed in the evening`, (later) => resumeDiscovery(later, campaign));
    },
  };
}

// ---------------------------------------------------------------- the three-week scenario

const START_DAY = "2027-03-15";
/** The last working day of the run: no kills and no faults (`Scenario.quietFrom`). */
const LAST_DAY = "2027-04-02";
export const THREE_WEEKS_START = rome(START_DAY, 8);
export const THREE_WEEKS_END = rome("2027-04-05", 8);

/** One short opening's campaign: one prospect, no note, no follow-up. */
const ONE_PROSPECT = {
  inviteNote: null,
  firstMessage: "Hi {{first_name}}, glad we are connected. How are things at {{company}}?",
  followUp: "",
  delayPolicy: "calendar",
} as const;

export const TEMPLATES = {
  A: {
    key: "A",
    inviteNote: "Hi {{first_name}}, I came across your work at {{company}} and would like to connect.",
    firstMessage: "Hi {{first_name}}, thanks for connecting. How is everything at {{company}}?",
    followUp: "Hi {{first_name}}, a quick follow-up on my last message. Would a short call make sense for {{company}}?",
    delayPolicy: "calendar",
    withdrawAfterDays: 21,
  },
  B: {
    key: "B",
    inviteNote: null,
    firstMessage: "Hello {{first_name}}, good to be connected. I help teams like {{company}} with their outreach.",
    // A blank follow-up: the sequence completes after the first message.
    followUp: "",
    delayPolicy: "working_days",
    // Small so that withdrawals of unanswered invitations happen inside the three weeks.
    withdrawAfterDays: 4,
  },
  C: {
    key: "C",
    inviteNote: null,
    firstMessage: "Hi {{first_name}}, nice to connect. What is the team at {{company}} focused on this year?",
    followUp: "Hi {{first_name}}, following up in case my note got buried.",
    delayPolicy: "calendar",
    withdrawAfterDays: 21,
  },
  // D, E and F each hold one prospect whose send the laptop sleeps through (`SEND_SLEEPS`).
  D: { key: "D", ...ONE_PROSPECT, withdrawAfterDays: 21 },
  // Invited on 2027-03-17, so its withdrawal is due on 2027-03-24.
  E: { key: "E", ...ONE_PROSPECT, withdrawAfterDays: 7 },
  F: { key: "F", ...ONE_PROSPECT, withdrawAfterDays: 21 },
} as const satisfies Record<string, CampaignSpec>;

/** Working days in weeks 1–2 on which the user approves a new batch (on a late-opening day, when the laptop opens). */
const ARRIVAL_DAYS = ["2027-03-16", "2027-03-17", "2027-03-18", "2027-03-19", "2027-03-22", "2027-03-26"];
const INITIAL_BATCH = 30;
const BATCH = 17;

/**
 * The app's weekly invite limit in this scenario (default 80). Low enough that the weekly limit, not
 * the daily one, ends invites in week 3: Monday's allowance is 15 (warm-up done) and Tuesday stops at
 * 13 of 15. Week 2 holds at most 11 + 13 = 24 (03-23 to 03-25 do no invites but one that sleeps
 * through), so the full day after the downtime, 03-26, is not cut short by it.
 */
export const WEEKLY_INVITE_LIMIT = 28;

export const THREE_WEEK_MINIMUMS: Minimums = {
  invites: 60,
  acceptancesObserved: 25,
  firstMessages: 25,
  followUps: 8,
  withdrawals: 3,
  stoppedReplied: 3,
  stoppedManual: 2,
  needsReview: 5,
  killsBefore: 1,
  killsTyped: 1,
  killsAfter: 1,
  killsBetween: 1,
  killsDuringReconcileRead: 1,
  killsBeforeTickCompleted: 1,
  reconcileConfirmedSent: 1,
  reconcileRetried: 1,
  safetyStopCheckpoint: 1,
  safetyStopLimit: 1,
  repliesMidSend: 2,
  suspendedReadsPlanned: 2,
  suspendedSendsPlanned: 3,
  changesMidTick: 3,
  settingsChangedMidRead: 2,
  killsOnReplyAndTakeover: 3,
  killsInBurst: 3,
  weeksStoppedByWeeklyLimit: 1,
  fullDaysAfterDowntimeAtLimit: 1,
  peopleDiscovered: 45,
  cardsScored: 40,
  profilesOpenedForScoring: 25,
  daysAtProfileViewLimit: 1,
  daysAtDiscoveryLimit: 1,
  searchCaps: 1,
  killsOnDiscovery: 3,
  // G and H. K exists for AI work during a safety stop: its suggestions are also G's, and since a
  // suggestions source now looks again every day instead of running out, K may rightly still be finding.
  awaitingApprovalReached: 2,
  discoveryResumedAfterApproval: 1,
  // Shows the found → scored → invited path runs; not a rate. Each invite attempt is charged its
  // profile load, retries included, so a seed with many killed invites leaves fewer views for
  // discovery (seed 3: 8, others 13–14).
  discoveredInvited: 5,
  aiCallsAtNight: 1,
  aiCallsDuringSafetyStop: 1,
};

/** LinkedIn's own weekly invitation cap in the world (rolling 7 days). The app's own invites never reach it; hand-sent ones do. */
export const WORLD_WEEKLY_INVITE_CAP = 50;

/**
 * Invitations the user sent by hand a week before the run, still counted by LinkedIn on the first
 * morning: with the two `invited_outside_app` ones, 47 of the 50, so LinkedIn refuses the app's
 * fourth invitation that reaches it (the first three always do: they come before noon, on scripted
 * members no random kill or fault touches). They age out at 15:00 on the first day, before invites
 * come back after the one-day cool-down.
 */
const HAND_SENT = { count: 45, at: rome("2027-03-08", 15) } as const;
/** Synthetic numbers of their members, far from the prospects'. */
const HAND_SENT_FIRST = 900;

interface ScriptedMember {
  readonly campaign: "A" | "B" | "D" | "E" | "F";
  readonly role: string;
  readonly extra: Partial<MemberSpec>;
  /** No first name on the people row, and a full name that starts with a title. */
  readonly unnamed?: boolean;
  readonly expect?: Expectation;
}

const times = (count: number, member: ScriptedMember): ScriptedMember[] => Array.from({ length: count }, () => member);

/**
 * The scripted cohort: fixed behaviour and early timings, enrolled before anyone else so each is
 * invited in the first days. Random kills and scripted faults never land on them (only the forced
 * kills below do), so every count assertion 7 requires is reached by this cohort alone in every
 * seed. What each count rests on:
 * - acceptances (25): 44 members accept within hours of the invite;
 * - first messages (25): A's 3 forced-kill targets, 3 killed mid-send, 2 whose settings or template change mid-read,
 *   14 silent, 3 repliers, 2 re-senders; B's 3 repliers, 4 silent, the one paused mid-read; F's one;
 * - follow-ups (8): the 17 silent members of A, early in A's queue;
 * - withdrawals (3): 5 members of B never accept and B withdraws after 4 days; E's one;
 * - stops for reply (3): 3 repliers, 2 who write first and 1 killed mid-send in A, 3 repliers and 2 mid-send in B;
 * - stops for manual takeover (2): 2 members the user writes to by hand, 2 he re-sends a message to;
 * - needs review (5): the 2 unnamed members here, the one whose send never succeeds, plus the special cases
 *   enrolled right after them (3 already connected, 2 invited outside the app, 2 offering Follow only);
 * - kills, reconciles: the forced kills on the first three silent members of A (`forcedKills`);
 * - replies mid-send (2), changes mid-tick (3), kills on the reply and takeover paths (3): the members below;
 * - settings changed mid-read (2): the message limit lowered, A's follow-up cleared (`interventions`);
 * - reads slept through (2): `LATE_OPENING_DAYS`; sends slept through (3): D, E and F (`SEND_SLEEPS`).
 * Each with a path of its own (`Expectation`):
 * - three killed during their first message, then replying or written to by hand (`forcedKills`), right after the
 *   first three of A so that their follow-up comes inside the run;
 * - one whose campaign's follow-up is cleared while their follow-up thread loads;
 * and, in B before its silent members:
 * - two whose reply lands between the app's thread read and its send (`replyMidSend`);
 * - one whose every message send fails before its effect (`sendNeverSucceeds`);
 * - one whose campaign is paused while its thread loads, and two the user rejects or stops while a read loads;
 * and one each in D, E and F whose invite, withdrawal and first message the laptop sleeps through.
 * Invites (60) come from volume: the scenario approves far more prospects than the budgets let through,
 * so the daily and weekly allowances are spent whatever the draw; LinkedIn's invitation limit from `HAND_SENT`.
 */
const SCRIPTED: readonly ScriptedMember[] = [
  // The forced kills' targets: first in line in A.
  ...times(3, { campaign: "A", role: "scripted_silent_forced_kill", extra: { acceptsAfterHours: 3 } }),
  // Killed during their first message, then replying or written to by hand: early, so the follow-up's thread read,
  // where the app sees what happened after the kill, comes well before the end of the run.
  // Replies 18 s after the first message, long before a restarted app (10–60 s, then a 45–180 s gap) checks it.
  { campaign: "A", role: "scripted_replies_after_kill", extra: { acceptsAfterHours: 3, repliesAfterHours: 0.005 }, expect: { kind: "stops_after_kill", reason: "replied", phase: "after" } },
  // The user re-sends the app's message by hand 18 s after it went out.
  { campaign: "A", role: "scripted_takeover_after_kill", extra: { acceptsAfterHours: 3, userResendsAfterHours: 0.005 }, expect: { kind: "stops_after_kill", reason: "manual_takeover", phase: "after" } },
  { campaign: "A", role: "scripted_takeover_typed_kill", extra: { acceptsAfterHours: 3, userResendsAfterHours: 3 }, expect: { kind: "stops_after_kill", reason: "manual_takeover", phase: "typed" } },
  ...times(3, { campaign: "B", role: "scripted_replies_after_first", extra: { acceptsAfterHours: 4, repliesAfterHours: 4 }, expect: { kind: "stops_on_reply" } }),
  // The user lowers the daily message limit while this member's first-message thread loads (`lowerMessageLimitMidRead`).
  { campaign: "A", role: "scripted_limit_lowered", extra: { acceptsAfterHours: 3 } },
  // The user clears A's follow-up while this member's follow-up thread loads (`clearFollowUpMidRead`).
  { campaign: "A", role: "scripted_follow_up_cleared", extra: { acceptsAfterHours: 3 }, expect: { kind: "follow_up_cleared_mid_read" } },
  ...times(14, { campaign: "A", role: "scripted_silent", extra: { acceptsAfterHours: 2 } }),
  ...times(2, { campaign: "A", role: "scripted_user_writes", extra: { acceptsAfterHours: 3, userWritesAfterHours: 2 } }),
  ...times(2, { campaign: "A", role: "scripted_user_resends", extra: { acceptsAfterHours: 3, userResendsAfterHours: 3 } }),
  { campaign: "A", role: "scripted_no_first_name", extra: { acceptsAfterHours: 10 }, unnamed: true, expect: { kind: "never_greeted" } },
  { campaign: "B", role: "scripted_no_first_name", extra: { acceptsAfterHours: 6 }, unnamed: true, expect: { kind: "never_greeted" } },
  ...times(3, { campaign: "A", role: "scripted_replies_after_first", extra: { acceptsAfterHours: 3, repliesAfterHours: 4 } }),
  ...times(2, { campaign: "A", role: "scripted_writes_first", extra: { acceptsAfterHours: 3, repliesBeforeFirstMessageAfterHours: 2 } }),
  ...times(5, { campaign: "B", role: "scripted_never_accepts", extra: { acceptsAfterHours: null } }),
  // In B, whose queue is shorter than A's, and before B's silent members, so each path is reached in the first two weeks.
  ...times(2, { campaign: "B", role: "scripted_replies_mid_send", extra: { acceptsAfterHours: 3 }, expect: { kind: "replies_mid_send" } }),
  { campaign: "B", role: "scripted_send_never_succeeds", extra: { acceptsAfterHours: 3 }, expect: { kind: "send_never_succeeds" } },
  { campaign: "B", role: "scripted_paused_mid_read", extra: { acceptsAfterHours: 3 }, expect: { kind: "paused_mid_read" } },
  { campaign: "B", role: "scripted_rejected_mid_tick", extra: { acceptsAfterHours: 3 }, expect: { kind: "changed_mid_tick", to: "rejected" } },
  { campaign: "B", role: "scripted_stopped_mid_tick", extra: { acceptsAfterHours: 3 }, expect: { kind: "changed_mid_tick", to: "stopped" } },
  ...times(4, { campaign: "B", role: "scripted_silent", extra: { acceptsAfterHours: 2 } }),
  // One each in D, E and F: the sends the laptop sleeps through (`SEND_SLEEPS`).
  { campaign: "D", role: "scripted_invite_sleeps", extra: { acceptsAfterHours: null }, expect: { kind: "send_slept_through", op: "sendInvite" } },
  { campaign: "E", role: "scripted_withdrawal_sleeps", extra: { acceptsAfterHours: null }, expect: { kind: "send_slept_through", op: "withdrawInvite" } },
  { campaign: "F", role: "scripted_message_sleeps", extra: { acceptsAfterHours: 2 }, expect: { kind: "send_slept_through", op: "sendMessage" } },
];

// ---------------------------------------------------------------- discovery in the three-week scenario

/**
 * Discovery, from 2027-03-17: campaign G finds people in My Network → Grow, campaign H in a two-page
 * search; both start in finding and are scored by the fake AI. G's 60 people come 15 to a load, 5
 * new each time (`G_POOL`); then the same 15 again, and three loads that bring nobody new exhaust
 * the source. H's second page meets LinkedIn's monthly search cap, so H waits for April.
 * Campaign K, from 2027-03-30, takes the new suggestions LinkedIn shows from that morning, while the
 * AI is out until half an hour after the checkpoint of 03-31: its cards are scored during that
 * safety stop. G's second load lands while the user pauses G until the evening: those cards are
 * scored at night. Among the people shown: 1st-degree connections, pending invitations, a
 * do-not-contact person, active prospects of A, people A contacted before the run, and a profile
 * LinkedIn shows as not available.
 */
const DISCOVERY_DAY = "2027-03-17";
/** From this instant My Network → Grow shows K's new suggestions; the AI is out from then too. */
const FRESH_SUGGESTIONS_FROM = rome("2027-03-30", 8);
export const SEARCH_URL = "https://www.linkedin.com/search/results/people/?keywords=head%20of%20operations%20turin";
const REC_WINDOW = 15;
const REC_STEP = 5;
/** The user approves what has waited this long in his queue (he looks at :20 every hour from 08:20 to 19:20). */
const APPROVAL_WAIT_MS = 3 * HOUR_MS;

const discoveryOf = (source: "recommendations" | "search", batchSize: number) =>
  ({ source, brief: DISCOVERY_BRIEF, openProfileThreshold: OPEN_PROFILE_THRESHOLD, scoreThreshold: SCORE_THRESHOLD, batchSize }) as const;

export const DISCOVERY_TEMPLATES = {
  G: {
    key: "G",
    inviteNote: "Hi {{first_name}}, I work with operations teams in Turin and would be glad to connect.",
    firstMessage: "Hi {{first_name}}, thanks for connecting. How are operations going at {{company}}?",
    followUp: "Hi {{first_name}}, just following up. Would a short call about {{company}} make sense?",
    withdrawAfterDays: 21,
    discovery: discoveryOf("recommendations", 30),
  },
  H: {
    key: "H",
    inviteNote: null,
    firstMessage: "Hello {{first_name}}, good to connect. What is {{company}} working on this quarter?",
    followUp: "Hello {{first_name}}, a short follow-up in case my message got lost.",
    withdrawAfterDays: 21,
    // A batch of three: page 1 fills the line with people waiting for approval, page 2 waits for the approval.
    discovery: { ...discoveryOf("search", 3), searchUrl: SEARCH_URL },
  },
  K: {
    key: "K",
    inviteNote: null,
    firstMessage: "Hi {{first_name}}, glad we are connected. How is the logistics side at {{company}}?",
    followUp: "",
    withdrawAfterDays: 21,
    discovery: discoveryOf("recommendations", 8),
  },
} as const satisfies Record<string, CampaignSpec>;

/** G's people in the order its loads show them; the specials are spread over the first loads. */
const G_SPECIAL: Readonly<Record<number, DiscoveredKind>> = {
  1: "pending_invite",
  4: "do_not_contact",
  8: "active_elsewhere",
  12: "unavailable",
  17: "contacted_before",
  22: "active_elsewhere",
  27: "pending_invite",
  33: "contacted_before",
};
/** G's people also on H's second page (H loads it in April, when G has them already). */
const G_SHARED = [41, 47, 53];
/** G's people LinkedIn suggests again with K's (`threeWeekRecommendations`). */
const G_AGAIN = [0, 5, 10];
/**
 * G's regular cards: most are opened and then rejected on the profile (`mid`), few wait for
 * approval, so G spends many profile views and page loads before its line fills with people
 * waiting: G is what brings the profile-view and discovery-page limits within reach in a day.
 */
const G_CYCLE: readonly CardKind[] = ["mid", "low", "mid", "high", "mid", "low3", "mid", "mid", "low", "mid", "mid_up", "mid", "low3", "mid", "mid", "low"];
const G_FIRST = 601;

function gPool(): DiscoveredSpec[] {
  return Array.from({ length: 60 }, (_, i): DiscoveredSpec => {
    const kind = G_SPECIAL[i] ?? "regular";
    const shared = G_SHARED.includes(i);
    const card: CardKind = kind !== "regular" || shared ? "high" : (G_CYCLE[i % G_CYCLE.length] ?? "low");
    // G's first person is the target of a forced kill on their scoring view: no fault may take that view away.
    return { n: G_FIRST + i, card, kind, campaigns: shared ? ["G", "H"] : G_AGAIN.includes(i) ? ["G", "K"] : ["G"], scripted: i === 0 };
  });
}

/** H's own people, page 1 then page 2 (H's second page also shows the three `G_SHARED`). */
const H_PAGE_1: readonly (readonly [CardKind, DiscoveredKind])[] = [
  ["high", "first_degree"],
  ["high", "regular"],
  ["low", "regular"],
  ["high", "first_degree"],
  ["mid_up", "regular"],
  ["high", "pending_invite"],
  ["low3", "regular"],
  ["high", "first_degree"],
  ["high", "regular"],
  ["low", "regular"],
];
const H_PAGE_2: readonly (readonly [CardKind, DiscoveredKind])[] = [
  ["high", "regular"],
  ["mid", "regular"],
  ["low", "regular"],
  ["high", "regular"],
  ["mid_up", "regular"],
  ["low3", "regular"],
  ["high", "regular"],
];
const H_FIRST = 661;

function hPool(): DiscoveredSpec[] {
  return [...H_PAGE_1, ...H_PAGE_2].map(([card, kind], i) => ({ n: H_FIRST + i, card, kind, campaigns: ["H"] }));
}

/** The suggestions LinkedIn shows from `FRESH_SUGGESTIONS_FROM` (with three of G's people again). G could see them too. */
const K_CARDS: readonly (readonly [CardKind, DiscoveredKind])[] = [
  ["high", "regular"],
  ["low", "regular"],
  ["mid_up", "regular"],
  ["high", "regular"],
  ["low3", "regular"],
  ["high", "regular"],
  ["high", "pending_invite"],
  ["low", "regular"],
  ["high", "regular"],
  ["mid_up", "regular"],
  ["low", "regular"],
  ["high", "regular"],
];
const K_FIRST = 681;

function kPool(): DiscoveredSpec[] {
  return K_CARDS.map(([card, kind], i) => ({ n: K_FIRST + i, card, kind, campaigns: ["G", "K"] }));
}

const idOf = (n: number): string => synthetic(n).spec.publicId;

/** H's search results: page 1, then page 2 with the shared people spread over it. */
function searchResults(): string[] {
  const own = (from: number, length: number) => Array.from({ length }, (_, i) => idOf(H_FIRST + from + i));
  const [s1, s2, s3] = G_SHARED.map((i) => idOf(G_FIRST + i));
  const page2 = own(H_PAGE_1.length, H_PAGE_2.length);
  return [...own(0, H_PAGE_1.length), s1 ?? "", ...page2.slice(0, 2), s2 ?? "", ...page2.slice(2, 4), s3 ?? "", ...page2.slice(4)];
}

/** What My Network → Grow shows at a load: G's window for that load, or K's new suggestions from `FRESH_SUGGESTIONS_FROM`. */
function threeWeekRecommendations(load: number, now: Date): RecommendationGroupSpec[] {
  if (now >= FRESH_SUGGESTIONS_FROM) {
    return recommendationGroups([...K_CARDS.map((_, i) => idOf(K_FIRST + i)), ...G_AGAIN.map((i) => idOf(G_FIRST + i))]);
  }
  const last = (60 - REC_WINDOW) / REC_STEP;
  const from = Math.min(load, last) * REC_STEP;
  return recommendationGroups(Array.from({ length: REC_WINDOW }, (_, i) => idOf(G_FIRST + from + i)));
}

function threeWeekDiscovery(): DiscoveryPlan {
  return {
    recommendations: threeWeekRecommendations,
    unavailableProfiles: Object.entries(G_SPECIAL).flatMap(([i, kind]) => (kind === "unavailable" ? [idOf(G_FIRST + Number(i))] : [])),
    searchCaps: [{ page: 2 }],
    aiOutages: [{ from: FRESH_SUGGESTIONS_FROM, until: { kind: "after_safety_stop", reason: "checkpoint", ms: 30 * 60_000, latest: rome("2027-04-01", 8) } }],
  };
}

/** The world public id of the nth scripted member (from 1). */
function scriptedId(n: number): string {
  return synthetic(n).spec.publicId;
}

/** The world public ids of the scripted members with this role, in order. */
function scriptedIds(role: string): string[] {
  return SCRIPTED.flatMap((member, index) => (member.role === role ? [scriptedId(index + 1)] : []));
}

function onlyOne(role: string): string {
  const [id, ...rest] = scriptedIds(role);
  if (id === undefined || rest.length > 0) throw new Error(`expected one scripted member with role ${role}`);
  return id;
}

/** What the user and the members do while a tick runs (items: reply mid-send, a send that never succeeds, changes in the app). */
function interventions(): Intervention[] {
  return [
    ...scriptedIds("scripted_replies_mid_send").map(replyMidSend),
    sendNeverSucceeds(onlyOne("scripted_send_never_succeeds")),
    pauseMidRead(onlyOne("scripted_paused_mid_read"), "B", 2 * HOUR_MS),
    closeMidRead(onlyOne("scripted_rejected_mid_tick"), "viewProfile", "rejected"),
    closeMidRead(onlyOne("scripted_stopped_mid_tick"), "readThread", "stopped"),
    lowerMessageLimitMidRead(onlyOne("scripted_limit_lowered")),
    clearFollowUpMidRead(onlyOne("scripted_follow_up_cleared"), "A", 2 * HOUR_MS),
    pauseDuringLoad("G", 2, 19),
  ];
}

/**
 * Days the laptop stays shut until 17:45, so the app's first read starts in the last 15 minutes of
 * the window. On both days every prospect that can be worked is scripted: invites go in approval
 * order, each campaign's scripted cohort is longer than the invites possible by then, and only an
 * invited prospect has later steps.
 */
const LATE_OPENING_DAYS = ["2027-03-16", "2027-03-19"] as const;

/**
 * The days of the long downtime on which the laptop is opened at 17:45 for three quarters of an hour,
 * each for one send the laptop then sleeps through. The user pauses A, B and C for the downtime and
 * opens one of D, E and F on each, so that prospect's step is the only campaign work there is: an
 * invite (D), a withdrawal (E, due since that morning) and a first message (F, accepted on 03-17 and
 * paused since). Each opening is quiet: no random kill, fault or suspension delays the step.
 */
const SLEEP_OPENINGS = [
  { day: "2027-03-23", campaign: "D", op: "sendInvite" },
  { day: "2027-03-24", campaign: "E", op: "withdrawInvite" },
  { day: "2027-03-25", campaign: "F", op: "sendMessage" },
] as const;

/** The first read of a scripted member in 17:45–17:50 on those days takes two hours: the laptop slept while it loaded. */
function suspensionPlan(): SuspensionPlan {
  return {
    slots: LATE_OPENING_DAYS.map((day) => ({ from: rome(day, 17, 45), to: rome(day, 17, 50), ms: 2 * HOUR_MS })),
    // Each sleeper's send starts 8 minutes before the window closes and takes two hours.
    sends: SLEEP_OPENINGS.map(({ campaign, op }) => ({ op, target: sleeperOf(campaign), startsBeforeEndMs: 8 * 60_000, ms: 2 * HOUR_MS })),
    randomChance: 0.02,
    randomSendChance: 0.02,
    lateWithinMs: 15 * 60_000,
    lateMs: 2 * HOUR_MS,
    otherMs: [5 * 60_000, 150 * 60_000],
  };
}

function sleeperOf(campaign: string): string {
  const index = SCRIPTED.findIndex((member) => member.campaign === campaign);
  if (index === -1) throw new Error(`no scripted member in campaign ${campaign}`);
  return scriptedId(index + 1);
}

/**
 * One of each kill and reconcile path, on the first three scripted members of A:
 * 1. a kill after the invite went out; the restarted process is killed again at its first point
 *    (before it completes a tick), and the next one during the reconcile read; then the reconcile
 *    finds the invitation pending (confirmed sent);
 * 2. a kill before the invite went out; the reconcile finds Connect still offered (sent again);
 * 3. a kill with the first message typed but not sent; the reconcile counts no new message (sent again);
 * and one kill between two ticks on the first day. Then, on the reply and takeover paths: a kill
 * after the first message went out to a member who replies before the restarted app checks it; the
 * same to a member the user then writes to by hand; and a kill with the text typed to a member the
 * user writes to later. Last, a burst of three kills between ticks, a few seconds apart, once a run
 * of 10 pieces of work without a break is under way: a restart that forgets how long the run has
 * been would then let it grow past `breaks.everyActionsMax`.
 */
function forcedKills(): ForcedKill[] {
  const [first, second, third] = [1, 2, 3].map(scriptedId);
  if (first === undefined || second === undefined || third === undefined) throw new Error("no scripted members");
  return [
    { kind: "member", op: "sendInvite", phase: "after", target: first },
    { kind: "rekill", target: first },
    { kind: "reconcile_read", target: first },
    { kind: "member", op: "sendInvite", phase: "before", target: second },
    { kind: "member", op: "sendMessage", phase: "typed", target: third },
    { kind: "between", nth: 40 },
    { kind: "member", op: "sendMessage", phase: "after", target: onlyOne("scripted_replies_after_kill") },
    { kind: "member", op: "sendMessage", phase: "after", target: onlyOne("scripted_takeover_after_kill") },
    { kind: "member", op: "sendMessage", phase: "typed", target: onlyOne("scripted_takeover_typed_kill") },
    { kind: "burst", count: 3, runAtLeast: 10, restartMs: [2_000, 6_000] },
    // Discovery: a recommendations page and a search page killed after they loaded, and the scoring
    // view of G's first person killed after it opened.
    { kind: "nth", op: "listRecommendations", phase: "after", nth: 4 },
    { kind: "nth", op: "searchPeople", phase: "after", nth: 1 },
    { kind: "member", op: "viewProfile", phase: "after", target: idOf(G_FIRST) },
  ];
}

export function threeWeekScenario(seed: number): Scenario {
  const random = mulberry32(seed);
  const facts = emptyFacts();
  let next = SCRIPTED.length + 1;
  const nextNumber = (): number => next++;

  const regular = (context: SimContext, campaign: string): void => {
    const n = nextNumber();
    const { role, extra } = regularBehaviour(random);
    const member = synthetic(n, extra);
    enrol(context, { campaign, member: member.spec, role, firstName: member.firstName, company: member.company });
  };
  const batch = (context: SimContext, keys: readonly string[], size: number): void => {
    for (let i = 0; i < size; i++) regular(context, keys[Math.floor(random() * keys.length)] ?? "A");
  };

  /** People whose earlier prospect is closed after contact, with no active prospect: they get one in C. */
  const dynamicTraps = (context: SimContext, limit: number): void => {
    const closedAfterContact: ProspectStage[] = ["completed", "withdrawn", "stopped"];
    const closed = context.db
      .select({ personId: prospects.personId, publicId: people.publicId })
      .from(prospects)
      .innerJoin(people, eq(people.id, prospects.personId))
      .where(inArray(prospects.stage, closedAfterContact))
      .all();
    const active = new Set(
      context.db
        .select({ personId: prospects.personId })
        .from(prospects)
        .where(notInArray(prospects.stage, [...CLOSED_STAGES]))
        .all()
        .map((row) => row.personId),
    );
    const candidates = closed.filter((row) => !active.has(row.personId) && context.facts.members.get(row.publicId)?.trapSince === null);
    for (let i = 0; i < limit && candidates.length > 0; i++) {
      const [pick] = candidates.splice(Math.floor(random() * candidates.length), 1);
      if (pick === undefined) break;
      const fact = context.facts.members.get(pick.publicId);
      if (fact === undefined) continue;
      fact.trapSince = context.now;
      fact.role = `${fact.role}+trap_in_C`;
      enrolExisting(context, "C", pick.personId, pick.publicId);
    }
  };

  const preRunTraps: { personId: number; publicId: string }[] = [];

  const setup = (context: SimContext): void => {
    const { db, world, now } = context;
    // Default settings except: invites come back one day after LinkedIn's invitation-limit message
    // (default seven), so the path "limit hit, resumed, invites resume" is reachable inside three weeks
    // and the late opening on 03-16 has invites to work on; and the weekly invite limit is `WEEKLY_INVITE_LIMIT`.
    applySettings(context, { inviteLimitCooldownDays: 1, limits: { invitesPerWeek: WEEKLY_INVITE_LIMIT } });
    createCampaign(context, TEMPLATES.A);
    createCampaign(context, TEMPLATES.B);
    for (const key of ["D", "E", "F"] as const) createCampaign(context, { ...TEMPLATES[key], status: "paused" });

    SCRIPTED.forEach((script, index) => {
      const n = index + 1;
      const member = synthetic(n, { ...script.extra, ...(script.unnamed === true ? { fullName: `Dott. Sample ${pad3(n)}` } : {}) });
      enrol(context, {
        campaign: script.campaign,
        member: member.spec,
        role: script.role,
        firstName: script.unnamed === true ? null : member.firstName,
        company: member.company,
        scripted: true,
        ...(script.expect === undefined ? {} : { expect: script.expect }),
      });
    });
    const special = (campaign: string, role: string, extra: Partial<MemberSpec>, names: { first?: string | null; company?: string | null } = {}, person?: Partial<PersonRow>) => {
      const member = synthetic(nextNumber(), extra);
      const firstName = names.first === undefined ? member.firstName : names.first;
      const company = names.company === undefined ? member.company : names.company;
      return enrol(context, { campaign, member: member.spec, role, firstName, company, ...(person === undefined ? {} : { person }) });
    };
    const longAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
    special("A", "already_connected", { degree: 1, connectedAt: longAgo(60) });
    special("B", "already_connected", { degree: 1, connectedAt: longAgo(45) });
    special("A", "already_connected", { degree: 1, connectedAt: longAgo(30) });
    special("A", "invited_outside_app", { invitedOutsideApp: true, invitedAt: longAgo(3), acceptsAfterHours: 80 });
    special("B", "invited_outside_app", { invitedOutsideApp: true, invitedAt: longAgo(5) });
    special("A", "follow_only", { connectUnavailable: true });
    special("B", "follow_only", { connectUnavailable: true });
    special("A", "connect_in_more", { connectInMore: true, acceptsAfterHours: 30 });
    special("B", "connect_in_more", { connectInMore: true, acceptsAfterHours: 50 });
    // The user marked this person do-not-contact.
    special("A", "do_not_contact", { acceptsAfterHours: 5 }, {}, { doNotContact: true });
    // Right after the scripted cohort and these cases, so the weekly limit never keeps them from their invite.
    batch(context, ["A", "B"], INITIAL_BATCH);

    // Two people rows whose profiles turn out to share one member id. Pair X: neither contacted;
    // the old row's public id no longer opens a profile. Pair Y: the old row was contacted before the run.
    const pairX = synthetic(nextNumber(), { acceptsAfterHours: 20 });
    world.addMember(pairX.spec);
    enrol(context, { campaign: "A", member: pairX.spec, role: "shared_member_id_old_row", firstName: pairX.firstName, company: pairX.company, inWorld: true, person: { publicId: `${pairX.spec.publicId}-old`, memberId: pairX.spec.memberId } });
    enrol(context, { campaign: "B", member: pairX.spec, role: "shared_member_id_new_row", firstName: pairX.firstName, company: pairX.company, inWorld: true });

    const pairY = synthetic(nextNumber(), { acceptsAfterHours: 10 });
    const yOld = insertPerson(db, { publicId: `${pairY.spec.publicId}-old`, memberId: pairY.spec.memberId, fullName: pairY.spec.fullName, firstName: pairY.firstName, company: pairY.company }, now);
    closedBeforeRun(db, facts.campaigns.get("A")?.id ?? 0, yOld, "withdrawn", now);
    enrol(context, { campaign: "B", member: pairY.spec, role: "shared_member_id_contacted_before", firstName: pairY.firstName, company: pairY.company });
    const yFact = facts.members.get(pairY.spec.publicId);
    if (yFact !== undefined) {
      yFact.preRunInvites = 1;
      yFact.trapSince = now;
    }

    // Contacted in A before the run and closed there; they get a new approved prospect in C in week 2.
    for (const [stage, degree] of [["completed", 1], ["withdrawn", 2], ["stopped", 1]] as const) {
      const member = synthetic(nextNumber(), degree === 1 ? { degree: 1, connectedAt: longAgo(18), acceptsAfterHours: null } : { acceptsAfterHours: 12 });
      world.addMember(member.spec);
      const personId = insertPerson(db, { publicId: member.spec.publicId, memberId: member.spec.memberId, fullName: member.spec.fullName, firstName: member.firstName, company: member.company, degree }, now);
      closedBeforeRun(db, facts.campaigns.get("A")?.id ?? 0, personId, stage, now);
      facts.members.set(member.spec.publicId, {
        publicId: member.spec.publicId,
        memberId: member.spec.memberId,
        role: `contacted_before_run_${stage}`,
        prospects: [],
        preRunInvites: 1,
        trapSince: now,
        doNotContact: false,
        scripted: false,
        expect: null,
      });
      preRunTraps.push({ personId, publicId: member.spec.publicId });
    }

    // The user's invitations by hand (`HAND_SENT`): LinkedIn members only, never prospects of the app.
    for (let i = 0; i < HAND_SENT.count; i++) {
      world.addMember(synthetic(HAND_SENT_FIRST + i, { invitedOutsideApp: true, invitedAt: HAND_SENT.at, acceptsAfterHours: null }).spec);
    }

    // The people the discovery sources show. A regular one, once approved and invited, behaves as any other member.
    for (const spec of [...gPool(), ...hPool(), ...kPool()]) {
      const extra = spec.kind === "regular" ? regularBehaviour(random).extra : spec.kind === "active_elsewhere" ? { acceptsAfterHours: null } : {};
      addDiscovered(context, { ...spec, extra });
    }
    world.setSearchResults(SEARCH_URL, searchResults());
  };

  const events: ScenarioEvent[] = [];
  const at = (day: string, hour: number, minute: number, label: string, apply: (context: SimContext) => void) =>
    events.push({ at: rome(day, hour, minute), label, apply });
  const statuses = (keys: readonly string[], status: "running" | "paused") => (context: SimContext) => keys.forEach((key) => setCampaignStatus(context, key, status));

  at("2027-03-22", 8, 15, "campaign C created, with suppression traps", (context) => {
    createCampaign(context, TEMPLATES.C);
    for (const trap of preRunTraps) enrolExisting(context, "C", trap.personId, trap.publicId);
    dynamicTraps(context, 2);
    const member = synthetic(nextNumber(), { acceptsAfterHours: 6 });
    // C's first message needs the company.
    enrol(context, { campaign: "C", member: member.spec, role: "no_company", firstName: member.firstName, company: null });
  });
  for (const day of ARRIVAL_DAYS) {
    // Into A and B only: C's new prospects come from discovery (G and H) instead, so the campaigns
    // taking turns at invites from week 2 are three, as before, and A and B keep the share of the
    // weekly invites their scripted cohorts need.
    at(day, 8, 30, `new approved prospects (${BATCH})`, (context) => {
      batch(context, ["A", "B"], BATCH);
      if (day === "2027-03-26") dynamicTraps(context, 2);
    });
  }
  at("2027-03-17", 10, 0, "campaign B paused", statuses(["B"], "paused"));
  at("2027-03-18", 11, 0, "campaign B resumed", statuses(["B"], "running"));
  // E and F invite their prospect on 03-17, first in turn among invites that day; F is
  // paused again before its acceptance can lead to a message, until its opening on 03-25.
  at("2027-03-17", 8, 45, "campaigns E and F started", statuses(["E", "F"], "running"));
  at("2027-03-17", 13, 0, "campaign F paused", statuses(["F"], "paused"));
  // The long downtime (`SLEEP_OPENINGS`): applied when the laptop opens at 17:45.
  at("2027-03-23", 7, 0, "campaigns A, B and C paused for the downtime; D started", (context) => {
    statuses(["A", "B", "C"], "paused")(context);
    setCampaignStatus(context, "D", "running");
  });
  at("2027-03-24", 7, 0, "campaign D paused", statuses(["D"], "paused"));
  at("2027-03-25", 7, 0, "campaign F resumed", statuses(["F"], "running"));
  at("2027-03-25", 18, 30, "campaigns A, B, C and D resumed after the downtime", statuses(["A", "B", "C", "D"], "running"));

  // Discovery (see `DISCOVERY_DAY`). The user pauses G and H through the app on the days the laptop
  // opens only for a short while, so those openings keep the work they were planned for.
  at(DISCOVERY_DAY, 8, 0, "discovery campaigns G and H created", (context) => {
    createCampaign(context, DISCOVERY_TEMPLATES.G);
    createCampaign(context, DISCOVERY_TEMPLATES.H);
  });
  const discoveryPaused = (from: Date, to: Date) => {
    events.push({ at: from, label: "campaigns G and H paused", apply: (context) => ["G", "H"].forEach((key) => pauseDiscovery(context, key)) });
    events.push({ at: to, label: "campaigns G and H resumed", apply: (context) => ["G", "H"].forEach((key) => resumeDiscovery(context, key)) });
  };
  discoveryPaused(rome("2027-03-19", 7), rome("2027-03-19", 18, 30));
  discoveryPaused(rome("2027-03-23", 7), rome("2027-03-25", 18, 30));
  at("2027-03-30", 8, 0, "discovery campaign K created", (context) => createCampaign(context, DISCOVERY_TEMPLATES.K));
  const lookAtQueue = approvalQueueUser(APPROVAL_WAIT_MS);
  for (let day = DISCOVERY_DAY; day <= LAST_DAY; day = addDays(day, 1)) {
    if (!isWorkingDay(DEFAULT_SETTINGS, day)) continue;
    for (let hour = 8; hour <= 19; hour++) at(day, hour, 20, "the user looks at the approval queue", lookAtQueue);
  }

  const downtimes: Downtime[] = [
    // Shut all day until 17:45 (see `LATE_OPENING_DAYS`).
    ...LATE_OPENING_DAYS.map((day) => ({ from: rome(day, 7), to: rome(day, 17, 45) })),
    // The laptop is off from Tuesday to Thursday, opened only at 17:45–18:30 each day (`SLEEP_OPENINGS`),
    // and then overnight: Friday is a full working day after the downtime.
    { from: rome("2027-03-23", 7), to: rome("2027-03-23", 17, 45) },
    { from: rome("2027-03-23", 18, 30), to: rome("2027-03-24", 17, 45) },
    { from: rome("2027-03-24", 18, 30), to: rome("2027-03-25", 17, 45) },
    { from: rome("2027-03-25", 18, 30), to: rome("2027-03-26", 7) },
    // Asleep overnight and opened late the next morning.
    { from: rome("2027-04-01", 18, 30), to: rome("2027-04-02", 10, 30) },
  ];

  // Wednesday morning of week 3, while the app is at work (messages and checks: the weekly invite limit
  // stopped invites on Tuesday), so it meets the checkpoint that morning, before the user fixes it a
  // day later by himself.
  const checkpointAt = new Date(rome("2027-03-31", 9, 30).getTime() + Math.floor(random() * HOUR_MS));
  const faults = sprinkleFaults(random);

  return {
    name: "three weeks, Europe/Rome, across the 2027-03-28 daylight-saving change",
    start: THREE_WEEKS_START,
    end: THREE_WEEKS_END,
    world: { start: THREE_WEEKS_START, weeklyInviteCap: WORLD_WEEKLY_INVITE_CAP },
    facts,
    setup,
    events,
    downtimes,
    faults,
    sessionBreaks: [{ at: checkpointAt, kind: "checkpoint", userFixesBy: new Date(checkpointAt.getTime() + DAY_MS) }],
    kills: { sendPoint: 0.03, readPoint: 0.003, betweenTicks: 0.003, reconcileRead: 0.5, quickRekill: 0.15, ensureAfter: 0.4, forced: forcedKills() },
    interventions: interventions(),
    suspensions: suspensionPlan(),
    quietSpans: SLEEP_OPENINGS.map(({ day }) => ({ from: rome(day, 17, 45), to: rome(day, 18, 30) })),
    discovery: threeWeekDiscovery(),
    minimums: THREE_WEEK_MINIMUMS,
    // The engine's own wakeAt drives the run; this only adds a look every hour, as a runner polling for new work would.
    pollMs: 60 * 60_000,
    userResumeHours: [2, 6],
    // The run ends before Monday's window: without a quiet last day, a send killed at 17:50 on Friday
    // would still be unknown at the end only because the engine had no working time left to check it.
    quietFrom: rome(LAST_DAY, 0),
  };
}

/** A prospect contacted by the app before the run and closed in `stage`, with the person's suppression record. */
function closedBeforeRun(db: Db, campaignId: number, personId: number, stage: "completed" | "withdrawn" | "stopped", now: Date): void {
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const accepted = stage !== "withdrawn";
  const prospectId = db
    .insert(prospects)
    .values({
      campaignId,
      personId,
      score: 8,
      stage,
      stopReason: stage === "stopped" ? "replied" : null,
      foundAt: ago(30),
      approvedAt: ago(29),
      invitedAt: ago(28),
      acceptanceObservedAt: accepted ? ago(18) : null,
      firstMessageSentAt: accepted ? ago(16) : null,
      followUpSentAt: stage === "completed" ? ago(14) : null,
      replyDetectedAt: stage === "stopped" ? ago(15) : null,
      closedAt: ago(stage === "withdrawn" ? 7 : 14),
    })
    .returning({ id: prospects.id })
    .get().id;
  db.update(people).set({ contactedAt: ago(28), contactedProspectId: prospectId }).where(eq(people.id, personId)).run();
}

const FAULT_OPS: readonly DriverOp[] = [
  "viewProfile",
  "readThread",
  "sendInvite",
  "sendMessage",
  "withdrawInvite",
  "listRecentConnections",
  "listRecommendations",
  "searchPeople",
];
const FAULT_KINDS: readonly FaultKind[] = ["unexpected", "timeout_before_effect", "timeout_after_effect"];

/**
 * Zero to two scripted faults on each working day of the run before the quiet last day, at a random time inside the window.
 * A discovery page gets a timeout where the draw says an unexpected page: an unreadable discovery
 * page makes its source wait until the next day (decision 85), and a random one of those would
 * take away the day a run needs to reach its profile-view limit. `discovery.test.ts` covers that wait.
 */
function sprinkleFaults(random: RandomSource): ScheduledFault[] {
  const faults: ScheduledFault[] = [];
  for (let day = START_DAY; day < LAST_DAY; day = addDays(day, 1)) {
    if (!isWorkingDay(DEFAULT_SETTINGS, day)) continue;
    const { start, end } = windowOn(DEFAULT_SETTINGS, day);
    const count = Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const at = new Date(start.getTime() + Math.floor(random() * (end.getTime() - start.getTime())));
      const op = FAULT_OPS[Math.floor(random() * FAULT_OPS.length)] ?? "viewProfile";
      const fault = FAULT_KINDS[Math.floor(random() * FAULT_KINDS.length)] ?? "unexpected";
      const discoveryPage = op === "listRecommendations" || op === "searchPeople";
      faults.push({ at, op, fault: discoveryPage && fault === "unexpected" ? "timeout_before_effect" : fault });
    }
  }
  return faults;
}
