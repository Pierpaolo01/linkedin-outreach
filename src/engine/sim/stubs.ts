/**
 * Stub engines for the simulation's own tests. Each is a few lines over the fake driver: a
 * correct-enough inviter and messenger, and the same with one deliberate flaw switched on. They
 * prove the assertions can fail, and that the harness's kills land. They never run in production.
 */
import { and, desc, eq, inArray, isNotNull, ne, notInArray } from "drizzle-orm";
import { getSettings } from "../../config/settings";
import type { Db } from "../../db/index";
import { actions, campaigns, CLOSED_STAGES, people, prospects } from "../../db/schema";
import type { SendGuard } from "../../linkedin/driver";
import { SearchCapped } from "../../linkedin/errors";
import { flattenRecommendations } from "../../linkedin/parse/recommendations";
import { checkBudget } from "../budget";
import type { Driver, Engine, EngineDeps, TickResult } from "../ports";
import { renderTemplate } from "../template";
import { dayKey, endOfWorkingWindow, isInWorkingWindow, nextWorkingInstant, startOfNextDay } from "../workingWindow";
import {
  NO_KILLS,
  ZERO_MINIMUMS,
  type DiscoveredKind,
  type DiscoveryPlan,
  type Downtime,
  type EngineModule,
  type KillPlan,
  type Minimums,
  type Scenario,
  type SimContext,
} from "./harness";
import {
  addDiscovered,
  approvalQueueUser,
  createCampaign,
  DISCOVERY_TEMPLATES,
  emptyFacts,
  enrol,
  recommendationGroups,
  rome,
  SEARCH_URL,
  synthetic,
  TEMPLATES,
  type CardKind,
} from "./scenario";

export interface InviterFlaws {
  /** Acts at any hour. */
  readonly ignoreWindow?: boolean;
  /** Never asks the budget. */
  readonly ignoreDailyLimit?: boolean;
  /** Invites do-not-contact and already-contacted people. */
  readonly ignoreSuppression?: boolean;
  /** Sends first and records afterwards: a kill after the send makes it send again. */
  readonly noClaim?: boolean;
  /** Writes no ledger rows at all. */
  readonly noLedger?: boolean;
  /** Marks invites done in the ledger without sending them. */
  readonly phantomLedger?: boolean;
  /** Sends one invite and records two done invite rows for it. */
  readonly doubleLedger?: boolean;
  /** Owes five invites per working day since the start and pays the debt as fast as it can. */
  readonly catchUpAfterDowntime?: boolean;
  /** Catches every error, kills included, and carries on. */
  readonly swallowErrors?: boolean;
  /**
   * Claims right after the profile view without looking again: not at the window (a view the laptop
   * slept through ends after it closed), nor at the prospect's stage or its campaign (the user may
   * have changed them while the view loaded).
   */
  readonly noRecheckBeforeClaim?: boolean;
  /** Keeps the 2-minute gap but never takes a break. */
  readonly noBreaks?: boolean;
  /** Counts pieces of work towards its break in memory only: a restarted process starts again from zero. */
  readonly breakCountResetsOnRestart?: boolean;
  /** Gives the driver no deadline: an invite the laptop sleeps through goes out whenever it wakes. */
  readonly ignoreGuard?: boolean;
}

const GAP_MS = 120_000;
const HOUR_MS = 3_600_000;
const SLEEP_MS = 15 * 60_000;
/** The correct-enough inviter's break: this long after every `BREAK_EVERY` pieces of work. */
const BREAK_EVERY = 10;
const BREAK_MS = 15 * 60_000;
/** Ledger rows closer than this belong to one piece of work (the stubs' pieces are `GAP_MS` apart). */
const SAME_PIECE_MS = 45_000;
/** A deadline that never passes: what a stub that ignores the guard gives the driver. */
const NO_DEADLINE: SendGuard = { notAfter: new Date(8_640_000_000_000_000) };

/** The deadline a correct stub gives the driver: the end of the working window it claims in (outside one, now: already past when the send acts). */
function windowGuard(db: Db, now: Date): SendGuard {
  const settings = getSettings(db);
  return { notAfter: isInWorkingWindow(settings, now) ? endOfWorkingWindow(settings, now) : now };
}

/**
 * Pieces of work the ledger shows since the last pause of `breaks.minutesMin` or more, counting
 * rows closer than `SAME_PIECE_MS` as one piece; none when the last row is that pause old already.
 */
function piecesSincePause(db: Db, now: Date): number {
  const pauseMs = getSettings(db).breaks.minutesMin * 60_000;
  const starts = db
    .select({ at: actions.startedAt })
    .from(actions)
    .where(isNotNull(actions.startedAt))
    .orderBy(desc(actions.startedAt))
    .all()
    .flatMap((row) => (row.at === null ? [] : [row.at.getTime()]));
  let newer = now.getTime();
  let pieces = 0;
  for (const at of starts) {
    const gap = newer - at;
    if (gap >= pauseMs) break;
    if (pieces === 0 || gap >= SAME_PIECE_MS) pieces += 1;
    newer = at;
  }
  return pieces;
}

function moduleOf(create: (deps: EngineDeps) => Engine): EngineModule {
  return { createEngine: create, resumeSafetyStop: () => false };
}

interface Due {
  readonly prospectId: number;
  readonly personId: number;
  readonly publicId: string;
  readonly memberId: string | null;
  readonly fullName: string;
  readonly firstName: string | null;
  readonly company: string | null;
  readonly inviteNote: string | null;
  readonly firstMessage: string;
  readonly doNotContact: boolean;
  readonly contactedAt: Date | null;
}

function dueProspects(db: Db, stage: "approved" | "accepted"): Due[] {
  return db
    .select({
      prospectId: prospects.id,
      personId: people.id,
      publicId: people.publicId,
      memberId: people.memberId,
      fullName: people.fullName,
      firstName: people.firstName,
      company: people.company,
      inviteNote: campaigns.inviteNote,
      firstMessage: campaigns.firstMessage,
      doNotContact: people.doNotContact,
      contactedAt: people.contactedAt,
    })
    .from(prospects)
    .innerJoin(people, eq(people.id, prospects.personId))
    .innerJoin(campaigns, eq(campaigns.id, prospects.campaignId))
    .where(and(eq(prospects.stage, stage), eq(campaigns.status, "running")))
    .orderBy(prospects.id)
    .all();
}

function lastActionAt(db: Db): number {
  const row = db.select({ at: actions.startedAt }).from(actions).where(isNotNull(actions.startedAt)).orderBy(desc(actions.startedAt)).get();
  return row?.at?.getTime() ?? 0;
}

function hold(db: Db, prospectId: number, reason: string): void {
  db.update(prospects).set({ stage: "needs_review", reviewReason: reason }).where(eq(prospects.id, prospectId)).run();
}

let viewCounter = 0;

function recordView(db: Db, prospectId: number, now: Date): void {
  viewCounter += 1;
  db.insert(actions).values({ type: "profile_view", prospectId, status: "done", idempotencyKey: `view:${prospectId}:${now.getTime()}:${viewCounter}`, attempts: 1, startedAt: now, finishedAt: now }).run();
}

/** Invites approved prospects one per tick: view the profile, look again, claim, send, record. */
export function inviter(flaws: InviterFlaws = {}): EngineModule {
  return moduleOf(({ db, driver: real, clock }) => {
    // Pieces of work since the last break: from the ledger on the first tick (unless the flaw keeps it
    // in memory only), then counted in memory.
    let pieces: number | null = null;
    let loaded = false;
    let breakUntil = 0;
    const driver: Driver = {
      ...real,
      viewProfile: (publicId) => {
        loaded = true;
        return real.viewProfile(publicId);
      },
      sendInvite: (person, note, guard) => {
        loaded = true;
        return real.sendInvite(person, note, guard);
      },
    };

    /** On a new process's first tick: where the count stands, and a break at once if it is due. */
    function resumeCount(): void {
      if (pieces !== null) return;
      pieces = flaws.breakCountResetsOnRestart === true ? 0 : piecesSincePause(db, clock.now());
      if (pieces < BREAK_EVERY || flaws.noBreaks) return;
      pieces = 0;
      breakUntil = lastActionAt(db) + BREAK_MS;
    }

    /** Whether the prospect may still be claimed: in the window, still approved, its campaign running. */
    function stillClaimable(prospectId: number): boolean {
      if (flaws.noRecheckBeforeClaim) return true;
      if (!isInWorkingWindow(getSettings(db), clock.now())) return false;
      const row = db
        .select({ stage: prospects.stage, status: campaigns.status })
        .from(prospects)
        .innerJoin(campaigns, eq(campaigns.id, prospects.campaignId))
        .where(eq(prospects.id, prospectId))
        .get();
      return row?.stage === "approved" && row.status === "running";
    }

    async function reconcile(): Promise<string | null> {
      const open = db.select().from(actions).where(and(eq(actions.type, "invite"), inArray(actions.status, ["in_progress", "unknown"]))).get();
      if (open === undefined || open.prospectId === null) return null;
      const person = db.select().from(people).innerJoin(prospects, eq(prospects.personId, people.id)).where(eq(prospects.id, open.prospectId)).get();
      if (person === undefined) return null;
      const profile = await driver.viewProfile(person.people.publicId);
      const now = clock.now();
      if (profile.connectionState === "pending" || profile.connectionState === "connected") {
        db.update(actions).set({ status: "done", finishedAt: now }).where(eq(actions.id, open.id)).run();
        db.update(prospects).set({ stage: "invited", invitedAt: now }).where(eq(prospects.id, open.prospectId)).run();
        return "reconciled: sent";
      }
      db.update(actions).set({ status: "planned" }).where(eq(actions.id, open.id)).run();
      return "reconciled: not sent";
    }

    async function work(): Promise<TickResult> {
      const now = clock.now();
      const settings = getSettings(db);
      if (!flaws.ignoreWindow && !isInWorkingWindow(settings, now)) return { did: null, wakeAt: nextWorkingInstant(settings, now) };
      if (now.getTime() < breakUntil) return { did: null, wakeAt: new Date(breakUntil) };
      if (!flaws.catchUpAfterDowntime && now.getTime() < lastActionAt(db) + GAP_MS) return { did: null, wakeAt: new Date(lastActionAt(db) + GAP_MS) };
      db.update(actions).set({ status: "unknown" }).where(eq(actions.status, "in_progress")).run();
      const reconciled = await reconcile();
      if (reconciled !== null) return { did: reconciled, wakeAt: new Date(clock.now().getTime() + GAP_MS) };

      if (flaws.catchUpAfterDowntime) {
        const owed = 5 * Math.ceil((now.getTime() - rome("2027-03-15", 0).getTime()) / 86_400_000);
        const sent = db.select().from(actions).where(eq(actions.type, "invite")).all().length;
        if (sent >= owed) return { did: null, wakeAt: new Date(now.getTime() + SLEEP_MS) };
      } else if (!flaws.ignoreDailyLimit) {
        const invites = checkBudget(db, settings, "invite", now);
        const views = checkBudget(db, settings, "profile_view", now);
        if (!invites.allowed || !views.allowed) return { did: null, wakeAt: invites.resumesAt ?? views.resumesAt ?? new Date(now.getTime() + SLEEP_MS) };
      }
      const due = dueProspects(db, "approved")[0];
      if (due === undefined) return { did: null, wakeAt: new Date(now.getTime() + SLEEP_MS) };
      if (!flaws.ignoreSuppression && (due.doNotContact || due.contactedAt !== null)) {
        hold(db, due.prospectId, "suppressed");
        return { did: `held ${due.publicId}`, wakeAt: new Date(now.getTime() + GAP_MS) };
      }

      if (flaws.phantomLedger) {
        markInvited(db, due, now, "done");
        return { did: `phantom invite ${due.publicId}`, wakeAt: new Date(now.getTime() + GAP_MS) };
      }
      if (flaws.noClaim && due.memberId !== null) {
        // It saved the member id before the kill, trusts it, and clicks Connect again without looking.
        await driver.sendInvite({ publicId: due.publicId, memberId: due.memberId }, null, windowGuard(db, clock.now()));
        markDone(db, due, clock.now(), flaws);
        return { did: `invited ${due.publicId} again`, wakeAt: new Date(clock.now().getTime() + GAP_MS) };
      }
      if (!flaws.noLedger) recordView(db, due.prospectId, now);
      const profile = await driver.viewProfile(due.publicId);
      const taken = db.select().from(people).where(and(eq(people.memberId, profile.memberId ?? ""), ne(people.id, due.personId))).get();
      if (taken !== undefined && !flaws.ignoreSuppression) {
        hold(db, due.prospectId, "member id belongs to another person");
        return { did: `held ${due.publicId}`, wakeAt: new Date(clock.now().getTime() + GAP_MS) };
      }
      if (taken === undefined) db.update(people).set({ memberId: profile.memberId }).where(eq(people.id, due.personId)).run();
      if (profile.connectionState !== "can_connect" && profile.connectionState !== "connect_in_more") {
        hold(db, due.prospectId, `profile shows ${profile.connectionState}`);
        return { did: `held ${due.publicId}`, wakeAt: new Date(clock.now().getTime() + GAP_MS) };
      }
      const note = due.inviteNote === null ? null : renderTemplate(due.inviteNote, { first_name: due.firstName, company: due.company }, { maxLength: 300 });
      if (note !== null && !note.ok) {
        hold(db, due.prospectId, `note: ${note.problem}`);
        return { did: `held ${due.publicId}`, wakeAt: new Date(clock.now().getTime() + GAP_MS) };
      }
      if (!stillClaimable(due.prospectId)) return { did: `not claimed ${due.publicId}`, wakeAt: new Date(clock.now().getTime() + GAP_MS) };
      const person = { publicId: due.publicId, memberId: profile.memberId ?? "" };
      const guard = flaws.ignoreGuard === true ? NO_DEADLINE : windowGuard(db, clock.now());
      if (flaws.noClaim) {
        await driver.sendInvite(person, note?.text ?? null, guard);
        if (!flaws.noLedger) markDone(db, due, clock.now(), flaws);
      } else {
        if (!flaws.noLedger) markInvited(db, due, clock.now(), "in_progress");
        const result = await driver.sendInvite(person, note?.text ?? null, guard);
        if (result === "expired") {
          // Nothing went out: the claim is given back and the next tick inside the window starts over.
          unclaimInvite(db, due, flaws.noLedger === true);
          return { did: `invite to ${due.publicId} expired`, wakeAt: new Date(clock.now().getTime() + GAP_MS) };
        }
        if (!flaws.noLedger) markDone(db, due, clock.now(), flaws);
        else db.update(prospects).set({ stage: "invited", invitedAt: clock.now() }).where(eq(prospects.id, due.prospectId)).run();
      }
      const wait = flaws.catchUpAfterDowntime ? 1_000 : GAP_MS;
      return { did: `invited ${due.publicId}`, wakeAt: new Date(clock.now().getTime() + wait) };
    }

    /** Counts a piece of work that loaded LinkedIn and, every `BREAK_EVERY` of them, takes a break. */
    function paced(result: TickResult): TickResult {
      if (!loaded || flaws.noBreaks) return result;
      pieces = (pieces ?? 0) + 1;
      if (pieces < BREAK_EVERY) return result;
      pieces = 0;
      breakUntil = clock.now().getTime() + BREAK_MS;
      return { did: result.did, wakeAt: new Date(Math.max(result.wakeAt.getTime(), breakUntil)) };
    }

    return {
      async tick() {
        loaded = false;
        resumeCount();
        if (!flaws.swallowErrors) return paced(await work());
        try {
          return paced(await work());
        } catch {
          return { did: null, wakeAt: new Date(clock.now().getTime() + GAP_MS) };
        }
      },
    };
  });
}

/** Undoes an invite claim whose send expired: the row back to planned, the prospect approved, the person not contacted. */
function unclaimInvite(db: Db, due: Due, noLedger: boolean): void {
  db.transaction((tx) => {
    if (!noLedger) tx.update(actions).set({ status: "planned" }).where(eq(actions.idempotencyKey, `invite:${due.prospectId}`)).run();
    tx.update(prospects).set({ stage: "approved", invitedAt: null }).where(eq(prospects.id, due.prospectId)).run();
    tx.update(people).set({ contactedAt: null, contactedProspectId: null }).where(eq(people.id, due.personId)).run();
  });
}

function markDone(db: Db, due: Due, now: Date, flaws: InviterFlaws): void {
  markInvited(db, due, now, "done");
  if (flaws.doubleLedger) {
    db.insert(actions)
      .values({ type: "invite", prospectId: due.prospectId, status: "done", idempotencyKey: `invite:${due.prospectId}:again`, attempts: 1, startedAt: now, finishedAt: now })
      .run();
  }
}

function markInvited(db: Db, due: Due, now: Date, status: "in_progress" | "done"): void {
  db.transaction((tx) => {
    tx.insert(actions)
      .values({ type: "invite", prospectId: due.prospectId, status, idempotencyKey: `invite:${due.prospectId}`, attempts: 1, startedAt: now, ...(status === "done" ? { finishedAt: now } : {}) })
      .onConflictDoUpdate({ target: actions.idempotencyKey, set: { status, startedAt: now } })
      .run();
    tx.update(prospects).set({ stage: "invited", invitedAt: now }).where(eq(prospects.id, due.prospectId)).run();
    tx.update(people).set({ contactedAt: now, contactedProspectId: due.prospectId }).where(eq(people.id, due.personId)).run();
  });
}

export interface MessengerFlaws {
  /** Never judges the thread: reads it only for the message count the driver asks for, then sends. */
  readonly blind?: boolean;
  /** When the driver answers that the conversation changed, reads it again for the new count and sends anyway. */
  readonly ignoreThreadChanged?: boolean;
  /** With no first name, greets the first word of the full name. */
  readonly nameFromFullName?: boolean;
  /** Sends a follow-up the day after the first message even when the campaign has none. */
  readonly followUpAlways?: boolean;
  /** Asks the message budget when the tick starts, not again after the thread read: a limit lowered meanwhile is missed. */
  readonly noBudgetRecheck?: boolean;
}

/** Sends the first message to accepted prospects whose member id is known, reading the thread first unless `blind`. */
export function messenger({ blind = false, ignoreThreadChanged = false, nameFromFullName = false, followUpAlways = false, noBudgetRecheck = false }: MessengerFlaws = {}): EngineModule {
  return moduleOf(({ db, driver, clock }) => ({
    async tick(): Promise<TickResult> {
      const now = clock.now();
      const settings = getSettings(db);
      if (!isInWorkingWindow(settings, now)) return { did: null, wakeAt: nextWorkingInstant(settings, now) };
      if (now.getTime() < lastActionAt(db) + GAP_MS) return { did: null, wakeAt: new Date(lastActionAt(db) + GAP_MS) };
      const budget = checkBudget(db, settings, "message", now);
      if (!budget.allowed) return { did: null, wakeAt: budget.resumesAt ?? new Date(now.getTime() + SLEEP_MS) };
      if (followUpAlways) {
        const followUp = await blindFollowUp(db, driver, now);
        if (followUp !== null) return { did: followUp, wakeAt: new Date(clock.now().getTime() + GAP_MS) };
      }
      const open = db.select().from(actions).where(and(eq(actions.type, "message"), inArray(actions.status, ["in_progress", "unknown"]))).get();
      const due = dueProspects(db, "accepted").find((row) => row.memberId !== null && (open === undefined || open.prospectId === row.prospectId));
      if (due === undefined || due.memberId === null) return { did: null, wakeAt: new Date(now.getTime() + SLEEP_MS) };
      const firstName = due.firstName ?? (nameFromFullName ? (due.fullName.split(" ")[0] ?? null) : null);
      const text = renderTemplate(due.firstMessage, { first_name: firstName, company: due.company });
      if (!text.ok) {
        hold(db, due.prospectId, text.problem);
        return { did: "held", wakeAt: new Date(now.getTime() + GAP_MS) };
      }
      const person = { publicId: due.publicId, memberId: due.memberId };
      const key = `message1:${due.prospectId}`;
      const thread = await driver.readThread(person);
      if (!blind) {
        const sentAlready = thread.messages.some((message) => message.sender === "user" && message.text.replace(/\s+/g, " ") === text.text.replace(/\s+/g, " "));
        if (open !== undefined && sentAlready) {
          db.update(actions).set({ status: "done", finishedAt: clock.now() }).where(eq(actions.idempotencyKey, key)).run();
          db.update(prospects).set({ stage: "message_sent", firstMessageSentAt: clock.now() }).where(eq(prospects.id, due.prospectId)).run();
          return { did: "reconciled: sent", wakeAt: new Date(clock.now().getTime() + GAP_MS) };
        }
        if (thread.messages.length > 0) {
          db.update(prospects).set({ stage: "stopped", stopReason: "replied", closedAt: clock.now() }).where(eq(prospects.id, due.prospectId)).run();
          db.update(actions).set({ status: "failed" }).where(eq(actions.idempotencyKey, key)).run();
          return { did: "stopped", wakeAt: new Date(clock.now().getTime() + GAP_MS) };
        }
      }
      if (!noBudgetRecheck) {
        // Looked at again with fresh settings: the user may have lowered the limit while the thread loaded.
        const fresh = getSettings(db);
        const at = clock.now();
        if (!isInWorkingWindow(fresh, at) || !checkBudget(db, fresh, "message", at).allowed) return { did: `not claimed ${due.publicId}`, wakeAt: new Date(at.getTime() + GAP_MS) };
      }
      db.insert(actions)
        .values({ type: "message", prospectId: due.prospectId, status: "in_progress", idempotencyKey: key, attempts: 1, startedAt: clock.now() })
        .onConflictDoUpdate({ target: actions.idempotencyKey, set: { status: "in_progress", startedAt: clock.now() } })
        .run();
      let result = await driver.sendMessage(person, text.text, { ...windowGuard(db, clock.now()), messageCount: thread.messages.length });
      if (result === "thread_changed" && ignoreThreadChanged) {
        const again = await driver.readThread(person);
        result = await driver.sendMessage(person, text.text, { ...windowGuard(db, clock.now()), messageCount: again.messages.length });
      }
      if (result === "expired") {
        db.update(actions).set({ status: "planned" }).where(eq(actions.idempotencyKey, key)).run();
        return { did: `message to ${due.publicId} expired`, wakeAt: new Date(clock.now().getTime() + GAP_MS) };
      }
      if (result === "thread_changed") {
        // Nothing went out; the next tick reads the conversation again and judges it.
        db.update(actions).set({ status: "failed", finishedAt: clock.now() }).where(eq(actions.idempotencyKey, key)).run();
        return { did: `thread changed for ${due.publicId}`, wakeAt: new Date(clock.now().getTime() + GAP_MS) };
      }
      db.update(actions).set({ status: "done", finishedAt: clock.now() }).where(eq(actions.idempotencyKey, key)).run();
      db.update(prospects).set({ stage: "message_sent", firstMessageSentAt: clock.now() }).where(eq(prospects.id, due.prospectId)).run();
      return { did: `messaged ${due.publicId}`, wakeAt: new Date(clock.now().getTime() + GAP_MS) };
    },
  }));
}

/** The `followUpAlways` flaw: a day after the first message, sends "Following up." without judging the thread (it reads it only for the count). */
async function blindFollowUp(db: Db, driver: Driver, now: Date): Promise<string | null> {
  const due = db
    .select({ prospectId: prospects.id, publicId: people.publicId, memberId: people.memberId, sentAt: prospects.firstMessageSentAt })
    .from(prospects)
    .innerJoin(people, eq(people.id, prospects.personId))
    .where(eq(prospects.stage, "message_sent"))
    .orderBy(prospects.id)
    .all()
    .find((row) => row.memberId !== null && row.sentAt !== null && row.sentAt.getTime() + 86_400_000 <= now.getTime());
  if (due === undefined || due.memberId === null) return null;
  const person = { publicId: due.publicId, memberId: due.memberId };
  const thread = await driver.readThread(person);
  await driver.sendMessage(person, "Following up.", { ...NO_DEADLINE, messageCount: thread.messages.length });
  db.update(prospects).set({ stage: "completed", followUpSentAt: now, closedAt: now }).where(eq(prospects.id, due.prospectId)).run();
  return `followed up ${due.publicId}`;
}

// ---------------------------------------------------------------- discovery

export interface DiscovererFlaws {
  /** Opens every scored card's profile, whatever the score. */
  readonly openEveryProfile?: boolean;
  /** Never asks the discovery-page budget. */
  readonly ignoreDiscoveryBudget?: boolean;
  /** Stores everyone a source shows (connected, pending, do-not-contact, contacted) and invites whoever it approves. */
  readonly ignoreExclusions?: boolean;
  /** Works at any hour. */
  readonly ignoreWindow?: boolean;
  /** Opens a profile in the same tick as an AI call. */
  readonly loadInAiTick?: boolean;
  /** Keeps searching after LinkedIn's search cap. */
  readonly ignoreSearchCap?: boolean;
  /** Loads a page whatever its campaign's waiting line holds. */
  readonly ignoreWaitingLine?: boolean;
  /** Approves every card it opened, with no score and no reason. */
  readonly approveUnscored?: boolean;
}

type CampaignRow = typeof campaigns.$inferSelect;

let discoveryKeys = 0;

/** A ledger row claimed now (in progress) for a read: what the budgets count, and what the harness reads to attribute a page. */
function claimRow(db: Db, type: "recommendation_page" | "search_page" | "profile_view" | "invite", now: Date, campaignId: number, prospectId: number | null): number {
  discoveryKeys += 1;
  const key = type === "invite" && prospectId !== null ? `invite:${prospectId}` : `${type}:stub:${now.getTime()}:${discoveryKeys}`;
  return db
    .insert(actions)
    .values({ type, status: "in_progress", idempotencyKey: key, attempts: 1, startedAt: now, campaignId, prospectId })
    .returning({ id: actions.id })
    .get().id;
}

function finishRow(db: Db, id: number, status: "done" | "failed", now: Date, errorKind: string | null = null): void {
  db.update(actions).set({ status, finishedAt: now, errorKind }).where(eq(actions.id, id)).run();
}

function waitingLine(db: Db, campaignId: number): number {
  return db.select({ id: prospects.id }).from(prospects).where(and(eq(prospects.campaignId, campaignId), inArray(prospects.stage, ["found", "pending_approval"]))).all().length;
}

/** The first instant of the next month, local: when the stub searches again after LinkedIn's cap. */
function nextMonth(timeZone: string, at: Date): Date {
  let day = startOfNextDay(timeZone, at);
  while (!dayKey(timeZone, day).endsWith("-01")) day = startOfNextDay(timeZone, day);
  return day;
}

/**
 * Discovers, scores and invites with the fake AI it is given, one piece per tick, for campaigns in
 * finding or running: AI work first (any hour), then an invite, a profile view for scoring, a
 * discovery page. A profile scored at or above the threshold waits for the user's approval, and its
 * campaign, if still finding, awaits it. Correct enough to pass every assertion, until a flaw is
 * switched on.
 */
export function discoverer(flaws: DiscovererFlaws = {}): EngineModule {
  return moduleOf(({ db, driver, clock, ai: given }) => {
    if (given === undefined) throw new Error("the discoverer needs an AI");
    const ai = given;

    /** Campaigns that discover: in finding or running, with recommendations or a search URL to load. */
    function collecting(): CampaignRow[] {
      return db
        .select()
        .from(campaigns)
        .where(inArray(campaigns.status, ["finding", "running"]))
        .orderBy(campaigns.id)
        .all()
        .filter((campaign) => campaign.discoverySource === "recommendations" || campaign.sourceUrls.length > 0);
    }

    function foundWith(campaign: CampaignRow): { prospectId: number; person: typeof people.$inferSelect; cardScore: number | null; score: number | null }[] {
      return db
        .select({ prospectId: prospects.id, person: people, cardScore: prospects.cardScore, score: prospects.score })
        .from(prospects)
        .innerJoin(people, eq(people.id, prospects.personId))
        .where(and(eq(prospects.campaignId, campaign.id), eq(prospects.stage, "found")))
        .orderBy(prospects.id)
        .all();
    }

    /** One AI call's worth of scoring, or null when there is none. */
    async function score(): Promise<string | null> {
      for (const campaign of collecting()) {
        const found = foundWith(campaign);
        const unscored = found.filter((row) => row.cardScore === null);
        if (unscored.length > 0) {
          const cards = unscored.map(({ person }) => ({ publicId: person.publicId, fullName: person.fullName, headline: person.headline, location: person.location, company: person.company }));
          const answer = await ai.scoreCards(campaign.scoringBrief, cards);
          for (const row of unscored) {
            const scored = answer.value.find((one) => one.publicId === row.person.publicId);
            if (scored === undefined) continue;
            const below = scored.score < campaign.openProfileThreshold && flaws.openEveryProfile !== true;
            db.update(prospects)
              .set(below ? { cardScore: scored.score, score: scored.score, scoreReason: scored.reason, stage: "rejected", closedAt: clock.now() } : { cardScore: scored.score })
              .where(eq(prospects.id, row.prospectId))
              .run();
          }
          return `scored ${unscored.length} cards`;
        }
        const viewed = found.find((row) => row.person.profileViewedAt !== null && row.score === null);
        if (viewed !== undefined) {
          if (flaws.approveUnscored === true) {
            db.update(prospects).set({ stage: "approved", approvedAt: clock.now() }).where(eq(prospects.id, viewed.prospectId)).run();
            return `approved ${viewed.person.publicId} unscored`;
          }
          const profile = { publicId: viewed.person.publicId, fullName: viewed.person.fullName, headline: viewed.person.headline, location: viewed.person.location, about: null, currentTitle: viewed.person.title, currentCompany: viewed.person.company, experience: [] };
          const answer = await ai.scoreProfile(campaign.scoringBrief, profile);
          const cleaned = await ai.cleanVariables({ fullName: viewed.person.fullName, company: viewed.person.company });
          const fits = answer.value.score >= campaign.scoreThreshold;
          db.update(people).set({ firstName: cleaned.value.firstName, company: cleaned.value.companyShort ?? viewed.person.company }).where(eq(people.id, viewed.person.id)).run();
          db.update(prospects)
            .set({ score: answer.value.score, scoreReason: answer.value.reason, ...(fits ? { stage: "pending_approval" } : { stage: "rejected", closedAt: clock.now() }) })
            .where(eq(prospects.id, viewed.prospectId))
            .run();
          // Someone waits for the user: a campaign still finding asks for approval.
          if (fits) db.update(campaigns).set({ status: "awaiting_approval" }).where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "finding"))).run();
          return `scored the profile of ${viewed.person.publicId}`;
        }
      }
      return null;
    }

    /** Stores a page's cards as found prospects of the campaign, leaving out who it must (unless the flaw). */
    function store(campaign: CampaignRow, cards: readonly { publicId: string; profileUrl: string; fullName: string; headline: string | null; location: string | null; company: string | null; degree: 1 | 2 | 3 | null }[], now: Date): void {
      for (const card of cards) {
        if (card.degree === 1 && flaws.ignoreExclusions !== true) continue;
        const person =
          db.select().from(people).where(eq(people.publicId, card.publicId)).get() ??
          db
            .insert(people)
            .values({ publicId: card.publicId, profileUrl: card.profileUrl, fullName: card.fullName, headline: card.headline, location: card.location, company: card.company, connectionDegree: card.degree, discoverySource: campaign.discoverySource, firstSeenAt: now })
            .returning()
            .get();
        const elsewhere = db.select({ id: prospects.id }).from(prospects).where(and(eq(prospects.personId, person.id), notInArray(prospects.stage, [...CLOSED_STAGES]))).get();
        const here = db.select({ id: prospects.id }).from(prospects).where(and(eq(prospects.personId, person.id), eq(prospects.campaignId, campaign.id))).get();
        if (here !== undefined) continue;
        if (flaws.ignoreExclusions !== true && (person.doNotContact || person.contactedAt !== null || elsewhere !== undefined)) continue;
        db.insert(prospects).values({ campaignId: campaign.id, personId: person.id, stage: "found", foundAt: now }).run();
      }
    }

    /** One LinkedIn piece: an invite, a profile view for scoring, or a discovery page. Null when there is none. */
    async function linkedIn(now: Date): Promise<string | null> {
      const settings = getSettings(db);
      const approved = db
        .select({ prospectId: prospects.id, campaignId: prospects.campaignId, person: people })
        .from(prospects)
        .innerJoin(people, eq(people.id, prospects.personId))
        .innerJoin(campaigns, eq(campaigns.id, prospects.campaignId))
        .where(and(eq(prospects.stage, "approved"), eq(campaigns.status, "running")))
        .orderBy(prospects.id)
        .get();
      if (approved !== undefined && approved.person.memberId !== null && checkBudget(db, settings, "invite", now).allowed) {
        const id = claimRow(db, "invite", now, approved.campaignId, approved.prospectId);
        db.update(people).set({ contactedAt: now, contactedProspectId: approved.prospectId }).where(eq(people.id, approved.person.id)).run();
        db.update(prospects).set({ stage: "invited", invitedAt: now }).where(eq(prospects.id, approved.prospectId)).run();
        const result = await driver.sendInvite({ publicId: approved.person.publicId, memberId: approved.person.memberId }, null, windowGuard(db, clock.now()));
        finishRow(db, id, result === "sent" ? "done" : "failed", clock.now());
        return `invited ${approved.person.publicId}`;
      }
      for (const campaign of collecting()) {
        const toView = foundWith(campaign).find((row) => row.cardScore !== null && row.person.profileViewedAt === null && (row.cardScore >= campaign.openProfileThreshold || flaws.openEveryProfile === true));
        if (toView === undefined || !checkBudget(db, settings, "profile_view", now).allowed) continue;
        const id = claimRow(db, "profile_view", now, campaign.id, toView.prospectId);
        const profile = await driver.viewProfile(toView.person.publicId);
        db.update(people).set({ memberId: profile.memberId, title: profile.currentTitle, profileViewedAt: clock.now() }).where(eq(people.id, toView.person.id)).run();
        finishRow(db, id, "done", clock.now());
        if ((profile.connectionState === "pending" || profile.connectionState === "connected") && flaws.ignoreExclusions !== true) {
          db.update(prospects).set({ stage: "rejected", score: 0, scoreReason: `profile shows ${profile.connectionState}`, closedAt: clock.now() }).where(eq(prospects.id, toView.prospectId)).run();
        }
        return `viewed ${toView.person.publicId}`;
      }
      // Campaigns take turns at pages: the one whose last page is oldest first.
      const lastPage = (campaign: CampaignRow): number =>
        db
          .select({ at: actions.startedAt })
          .from(actions)
          .where(and(eq(actions.campaignId, campaign.id), inArray(actions.type, ["recommendation_page", "search_page"])))
          .orderBy(desc(actions.startedAt))
          .get()?.at?.getTime() ?? 0;
      for (const campaign of collecting().sort((a, b) => lastPage(a) - lastPage(b))) {
        if (flaws.ignoreWaitingLine !== true && waitingLine(db, campaign.id) >= campaign.batchSize) continue;
        if (flaws.ignoreDiscoveryBudget !== true && !checkBudget(db, settings, "discovery_page", now).allowed) continue;
        const url = campaign.sourceUrls[0];
        if (campaign.discoverySource === "search" && url !== undefined) {
          const capped = db.select({ at: actions.finishedAt }).from(actions).where(and(eq(actions.campaignId, campaign.id), eq(actions.errorKind, "search_capped"))).get();
          if (capped?.at != null && flaws.ignoreSearchCap !== true && now < nextMonth(settings.timeZone, capped.at)) continue;
          const page = db.select({ id: actions.id }).from(actions).where(and(eq(actions.campaignId, campaign.id), eq(actions.type, "search_page"), eq(actions.status, "done"))).all().length + 1;
          const id = claimRow(db, "search_page", now, campaign.id, null);
          try {
            const results = await driver.searchPeople({ url, page });
            store(campaign, results.cards, clock.now());
            finishRow(db, id, "done", clock.now());
          } catch (error) {
            if (!(error instanceof SearchCapped)) throw error;
            finishRow(db, id, "failed", clock.now(), "search_capped");
          }
          return `searched page ${page} for ${campaign.name}`;
        }
        const id = claimRow(db, "recommendation_page", now, campaign.id, null);
        store(campaign, flattenRecommendations(await driver.listRecommendations()), clock.now());
        finishRow(db, id, "done", clock.now());
        return `loaded recommendations for ${campaign.name}`;
      }
      return null;
    }

    return {
      async tick(): Promise<TickResult> {
        const now = clock.now();
        const scored = await score();
        if (scored !== null && flaws.loadInAiTick !== true) return { did: scored, wakeAt: new Date(now.getTime() + 1_000) };
        const settings = getSettings(db);
        if (flaws.ignoreWindow !== true && !isInWorkingWindow(settings, now)) return { did: scored, wakeAt: nextWorkingInstant(settings, now) };
        if (now.getTime() < lastActionAt(db) + GAP_MS) return { did: scored, wakeAt: new Date(lastActionAt(db) + GAP_MS) };
        // A break every `BREAK_EVERY` pieces of work, counted from the ledger.
        if (piecesSincePause(db, now) >= BREAK_EVERY) return { did: scored, wakeAt: new Date(lastActionAt(db) + BREAK_MS) };
        const did = await linkedIn(now);
        return { did: did ?? scored, wakeAt: new Date(clock.now().getTime() + (did === null ? SLEEP_MS : GAP_MS)) };
      },
    };
  });
}

export interface DiscoveryScenarioOptions {
  readonly days?: number;
  /** Campaign G's batch size (default 10). */
  readonly batchSize?: number;
  /** Also a search campaign H over `SEARCH_URL`, whose second page meets LinkedIn's search cap. */
  readonly search?: boolean;
  readonly kills?: KillPlan;
  /** The AI is out over these spans. */
  readonly aiOutages?: DiscoveryPlan["aiOutages"];
}

/**
 * Discovery campaign G over My Network → Grow (from 2027-03-15 08:00, 15 people a load, 5 new each
 * time, 30 people in all), with two people A contacted before the run, one do-not-contact person and
 * one pending invitation among them; optionally search campaign H (two pages, three of them 1st degree).
 */
export function discoveryScenario(options: DiscoveryScenarioOptions = {}): Scenario {
  const start = rome("2027-03-15", 8);
  const facts = emptyFacts();
  const kinds: Readonly<Record<number, DiscoveredKind>> = { 2: "contacted_before", 6: "do_not_contact", 9: "pending_invite", 13: "contacted_before" };
  const cards: readonly CardKind[] = ["high", "low", "mid", "high", "low3", "mid_up", "mid", "low"];
  const pool = Array.from({ length: 30 }, (_, i) => 401 + i);
  const user = approvalQueueUser(HOUR_MS);
  const searched = Array.from({ length: 20 }, (_, i) => 451 + i);
  return {
    name: "discovery",
    start,
    end: new Date(start.getTime() + (options.days ?? 2) * 86_400_000),
    world: { start },
    facts,
    setup(context) {
      createCampaign(context, TEMPLATES.A);
      // No invite note: the stub sends none.
      createCampaign(context, { ...DISCOVERY_TEMPLATES.G, inviteNote: null, discovery: { ...DISCOVERY_TEMPLATES.G.discovery, batchSize: options.batchSize ?? 10 } });
      pool.forEach((n, i) => addDiscovered(context, { n, card: kinds[i] === undefined ? (cards[i % cards.length] ?? "low") : "high", kind: kinds[i] ?? "regular", campaigns: ["G"], extra: { acceptsAfterHours: 5 } }));
      if (options.search === true) {
        createCampaign(context, DISCOVERY_TEMPLATES.H);
        searched.forEach((n, i) => addDiscovered(context, { n, card: i % 3 === 0 ? "low" : "high", kind: i < 3 ? "first_degree" : "regular", campaigns: ["H"], extra: { acceptsAfterHours: 5 } }));
        context.world.setSearchResults(SEARCH_URL, searched.map((n) => synthetic(n).spec.publicId));
      }
    },
    // The user looks at the approval queue every hour and approves what has waited an hour.
    events: Array.from({ length: (options.days ?? 2) * 24 }, (_, hour) => ({ at: new Date(start.getTime() + hour * HOUR_MS + 20 * 60_000), label: "the user looks at the approval queue", apply: user })),
    downtimes: [],
    faults: [],
    sessionBreaks: [],
    kills: options.kills ?? NO_KILLS,
    discovery: {
      recommendations: (load) => recommendationGroups(pool.slice(Math.min(load, 3) * 5, Math.min(load, 3) * 5 + 15).map((n) => synthetic(n).spec.publicId)),
      ...(options.search === true ? { searchCaps: [{ page: 2 }] } : {}),
      ...(options.aiOutages === undefined ? {} : { aiOutages: options.aiOutages }),
    },
    minimums: ZERO_MINIMUMS,
    pollMs: 15 * 60_000,
    userResumeHours: [2, 6],
  };
}

/** Does nothing, ever: a dead engine. */
export const idle: EngineModule = moduleOf(({ clock }) => ({
  tick: async () => ({ did: null, wakeAt: new Date(clock.now().getTime() + 60 * 60_000) }),
}));

// ---------------------------------------------------------------- small scenarios for the tests

export interface SmallScenarioOptions {
  readonly members?: number;
  readonly days?: number;
  readonly downtimes?: readonly Downtime[];
  readonly kills?: KillPlan;
  readonly minimums?: Minimums;
  /** Runs after the regular members are enrolled, at the start. */
  readonly extra?: (context: SimContext) => void;
  readonly acceptsAfterHours?: number | null;
}

/** Campaign A only (note, first message and follow-up), `members` regular members approved at the start. */
export function smallScenario(options: SmallScenarioOptions = {}): Scenario {
  const start = rome("2027-03-15", 8);
  const facts = emptyFacts();
  return {
    name: "small",
    start,
    end: new Date(start.getTime() + (options.days ?? 5) * 86_400_000),
    world: { start },
    facts,
    setup(context) {
      createCampaign(context, TEMPLATES.A);
      for (let n = 1; n <= (options.members ?? 10); n++) {
        const member = synthetic(n, { acceptsAfterHours: options.acceptsAfterHours === undefined ? 10 : options.acceptsAfterHours });
        enrol(context, { campaign: "A", member: member.spec, role: "regular", firstName: member.firstName, company: member.company });
      }
      options.extra?.(context);
    },
    events: [],
    downtimes: options.downtimes ?? [],
    faults: [],
    sessionBreaks: [],
    kills: options.kills ?? NO_KILLS,
    minimums: options.minimums ?? ZERO_MINIMUMS,
    pollMs: 15 * 60_000,
    userResumeHours: [2, 6],
  };
}
