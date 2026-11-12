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
 * Rows are inserted directly with Drizzle, as the approval queue would leave them. Every member is
 * synthetic: "<invented first name> Sample<NNN>" at "Example Works <NNN>", or "Dott. Sample <NNN>"
 * with no first name for the two members no template can greet.
 *
 * The helpers at the top are also what the tests' small scenarios are built from.
 */
import { eq, inArray, notInArray } from "drizzle-orm";
import { DEFAULT_SETTINGS, setSettings, type SettingsPatch } from "../../config/settings";
import type { Db } from "../../db/index";
import { campaigns, CLOSED_STAGES, people, prospects, type DelayPolicy, type ProspectStage } from "../../db/schema";
import type { DriverOp, FaultKind, MemberSpec } from "../../linkedin/fake/world";
import { profileUrlFor } from "../../linkedin/parse/card";
import type { RandomSource } from "../ports";
import {
  mulberry32,
  randomBetween,
  type CampaignFact,
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
  /** Default running. */
  readonly status?: "running" | "paused";
}

export function emptyFacts(): ScenarioFacts {
  return { settings: DEFAULT_SETTINGS, settingsHistory: [], campaigns: new Map(), members: new Map() };
}

/** The user changes settings: stored in the app, and remembered with the time for the verdicts. */
export function applySettings(context: SimContext, patch: SettingsPatch): void {
  const settings = setSettings(context.db, patch, context.now);
  context.facts.settings = settings;
  context.facts.settingsHistory.push({ at: context.now, settings });
}

export function createCampaign({ db, now, facts }: SimContext, spec: CampaignSpec): CampaignFact {
  const row = db
    .insert(campaigns)
    .values({
      name: `Campaign ${spec.key}`,
      status: spec.status ?? "running",
      discoverySource: "search",
      scoringBrief: "Simulated campaign",
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
  const fact: CampaignFact = { key: spec.key, id: row.id, inviteNote: spec.inviteNote, firstMessage: spec.firstMessage, followUp: spec.followUp };
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
      headline: "Operations lead",
      title: "Head of Operations",
      company: row.company,
      location: "Milan, Italy",
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

function memberFact(facts: ScenarioFacts, spec: MemberSpec, role: string, scripted: boolean, expect: Expectation | null): MemberFact {
  let fact = facts.members.get(spec.publicId);
  if (fact === undefined) {
    fact = { publicId: spec.publicId, memberId: spec.memberId, role, prospects: [], preRunInvites: 0, trapSince: null, doNotContact: false, scripted, expect };
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
  const fact = memberFact(facts, enrolment.member, enrolment.role, enrolment.scripted ?? false, enrolment.expect ?? null);
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
    at(day, 8, 30, `new approved prospects (${BATCH})`, (context) => {
      batch(context, context.facts.campaigns.has("C") ? ["A", "B", "C"] : ["A", "B"], BATCH);
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

const FAULT_OPS: readonly DriverOp[] = ["viewProfile", "readThread", "sendInvite", "sendMessage", "withdrawInvite", "listRecentConnections"];
const FAULT_KINDS: readonly FaultKind[] = ["unexpected", "timeout_before_effect", "timeout_after_effect"];

/** Zero to two scripted faults on each working day of the run before the quiet last day, at a random time inside the window. */
function sprinkleFaults(random: RandomSource): ScheduledFault[] {
  const faults: ScheduledFault[] = [];
  for (let day = START_DAY; day < LAST_DAY; day = addDays(day, 1)) {
    if (!isWorkingDay(DEFAULT_SETTINGS, day)) continue;
    const { start, end } = windowOn(DEFAULT_SETTINGS, day);
    const count = Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      faults.push({
        at: new Date(start.getTime() + Math.floor(random() * (end.getTime() - start.getTime()))),
        op: FAULT_OPS[Math.floor(random() * FAULT_OPS.length)] ?? "viewProfile",
        fault: FAULT_KINDS[Math.floor(random() * FAULT_KINDS.length)] ?? "unexpected",
      });
    }
  }
  return faults;
}
