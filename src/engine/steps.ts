/**
 * The handlers: one piece of due work each (spec sections 5–6, decisions 26–34). Every send goes
 * through a claim (ledger.ts); every read is a claimed ledger row. Only driver calls are caught;
 * a database error always rejects out of the tick.
 */
import { and, desc, eq, gt, isNotNull, isNull, ne, or } from "drizzle-orm";
import { getSettings, type Settings } from "../config/settings";
import type { Db } from "../db/index";
import { actions, campaigns, people, prospects, type ProspectStage } from "../db/schema";
import { LinkedInError, type LinkedInErrorKind } from "../linkedin/errors";
import type { Profile } from "../linkedin/parse/profile";
import { assertMove } from "./lifecycle";
import {
  claimRead,
  claimStep,
  finishAction,
  frozenText,
  INTERRUPTED,
  logEvent,
  stepOfKey,
  updateDetail,
  MAX_STEP_ATTEMPTS,
  type ActionRow,
  type Claim,
  type ClaimRefusal,
  type Conn,
  type ReadRequest,
  type Step,
} from "./ledger";
import type { Clock, Driver, PersonRef, RandomSource } from "./ports";
import { lastResumedAt, raiseSafetyStop } from "./safetyStop";
import { renderTemplate, type RenderResult, type TemplateValues } from "./template";
import { judgeSend, judgeThread } from "./threadCheck";
import { addDelay, isInWorkingWindow } from "./workingWindow";

export type ProspectRow = typeof prospects.$inferSelect;
export type CampaignRow = typeof campaigns.$inferSelect;
export type PersonRow = typeof people.$inferSelect;

/** A prospect with its campaign and person, as loaded when the work was picked. */
export interface Target {
  readonly prospect: ProspectRow;
  readonly campaign: CampaignRow;
  readonly person: PersonRow;
}

export interface StepContext {
  readonly db: Db;
  readonly driver: Driver;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly settings: Settings;
}

export interface StepOutcome {
  /** A few words for the log. */
  readonly did: string;
  /** True when LinkedIn was loaded, so the pacing gate applies. */
  readonly touchedLinkedIn: boolean;
}

type ProspectChanges = Partial<Omit<typeof prospects.$inferInsert, "id" | "stage">>;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** How long a prospect waits after a read failed for a reason other than LinkedIn's own pages. */
const RETRY_AFTER_MS = 30 * MINUTE_MS;
/** Failed reconcile reads before the prospect is held for review. */
const MAX_RECONCILE_FAILURES = 3;
/** Unexpected pages in a row that raise a safety stop. */
const UNEXPECTED_STREAK = 3;
const INVITE_NOTE_MAX = 300;

const SAFETY_KINDS: ReadonlySet<LinkedInErrorKind> = new Set(["logged_out", "checkpoint", "restricted", "limit_hit"]);

// ---------------------------------------------------------------- driver calls

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** Runs a driver call and turns its rejection into a value. Nothing but the driver call is inside the catch. */
function settle<T>(call: () => Promise<T>): Promise<Settled<T>> {
  return call().then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  );
}

interface ErrorFacts {
  readonly kind: LinkedInErrorKind | "error";
  readonly message: string;
  readonly screenshot: string | null;
}

function factsOf(error: unknown): ErrorFacts {
  if (error instanceof LinkedInError) {
    return { kind: error.kind, message: error.message, screenshot: error.artifacts?.screenshot ?? null };
  }
  return { kind: "error", message: error instanceof Error ? error.message : String(error), screenshot: null };
}

function isSafetyKind(kind: ErrorFacts["kind"]): kind is "logged_out" | "checkpoint" | "restricted" | "limit_hit" {
  return kind !== "error" && SAFETY_KINDS.has(kind);
}

function raiseFor(db: Conn, settings: Settings, facts: ErrorFacts, at: Date): void {
  if (!isSafetyKind(facts.kind)) return;
  raiseSafetyStop(
    db,
    {
      reason: facts.kind,
      detail: facts.message,
      ...(facts.screenshot === null ? {} : { screenshotPath: facts.screenshot }),
      ...(facts.kind === "limit_hit" ? { invitesBlockedUntil: new Date(at.getTime() + settings.inviteLimitCooldownDays * DAY_MS) } : {}),
    },
    at,
  );
}

/**
 * Raises `unexpected_pages` when the three most recently finished ledger rows that started after
 * the last resume all ended on an unexpected page (decision 34). A read a stopped run left
 * interrupted showed no page the app judged, so it neither counts nor breaks the streak.
 */
function checkUnexpectedStreak(db: Conn, at: Date): void {
  const resumed = lastResumedAt(db);
  const recent = db
    .select({ errorKind: actions.errorKind })
    .from(actions)
    .where(
      and(
        isNotNull(actions.finishedAt),
        or(isNull(actions.errorKind), ne(actions.errorKind, INTERRUPTED)),
        resumed === null ? undefined : gt(actions.startedAt, resumed),
      ),
    )
    .orderBy(desc(actions.finishedAt), desc(actions.id))
    .limit(UNEXPECTED_STREAK)
    .all();
  if (recent.length === UNEXPECTED_STREAK && recent.every((row) => row.errorKind === "unexpected")) {
    raiseSafetyStop(db, { reason: "unexpected_pages", detail: "three unexpected pages in a row" }, at);
  }
}

/** What happens to the prospect when a read fails for a reason other than a safety stop or an unexpected page. */
type OtherReadFailure = { readonly kind: "retry_later" } | { readonly kind: "reconcile"; readonly row: ActionRow };

type ReadResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** A read: a claimed ledger row, the driver call, then the row finished. Failures are handled here. */
async function read<T>(
  ctx: StepContext,
  type: ReadRequest["type"],
  target: Target | null,
  call: () => Promise<T>,
  other: OtherReadFailure = { kind: "retry_later" },
): Promise<ReadResult<T>> {
  const { db, clock } = ctx;
  const actionId = claimRead(
    db,
    { type, prospectId: target?.prospect.id ?? null, campaignId: target?.campaign.id ?? null },
    clock.now(),
  );
  const result = await settle(call);
  const at = clock.now();
  if (result.ok) {
    finishAction(db, actionId, { status: "done" }, at);
    return { ok: true, value: result.value };
  }
  const facts = factsOf(result.error);
  db.transaction((tx) => {
    finishAction(
      tx,
      actionId,
      { status: "failed", errorKind: facts.kind, error: facts.message, screenshotPath: facts.screenshot },
      at,
    );
    if (isSafetyKind(facts.kind)) {
      raiseFor(tx, ctx.settings, facts, at);
      return;
    }
    if (facts.kind === "unexpected") {
      if (target !== null) needsReview(tx, target, `LinkedIn showed a page the app does not recognise (${type})`, at);
      checkUnexpectedStreak(tx, at);
      return;
    }
    if (target === null) return;
    if (other.kind === "reconcile") {
      const failures = reconcileFailures(other.row) + 1;
      updateDetail(tx, other.row.id, { reconcileFailures: failures });
      if (failures >= MAX_RECONCILE_FAILURES) {
        needsReview(tx, target, `LinkedIn could not be checked ${failures} times for the unknown ${stepOfKey(other.row.idempotencyKey) ?? "step"}`, at);
        return;
      }
    }
    tx.update(prospects)
      .set({ nextActionAt: new Date(at.getTime() + RETRY_AFTER_MS) })
      .where(eq(prospects.id, target.prospect.id))
      .run();
  });
  return { ok: false };
}

function reconcileFailures(row: ActionRow): number {
  const value = row.detail?.["reconcileFailures"];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

type SendResult<T> = { readonly ok: true; readonly value: T; readonly at: Date } | { readonly ok: false };

const STEP_WORDS: Readonly<Record<Step, string>> = {
  invite: "Invite",
  message1: "First message",
  followup: "Follow-up",
  withdraw: "Withdrawal",
};

/**
 * A send after a successful claim. Any throw leaves the row unknown (decision 27), except LinkedIn's
 * own invitation limit on an invite, which by contract means nothing was sent: the row goes back to
 * planned and invites stop for the cool-down.
 */
async function send<T>(ctx: StepContext, target: Target, step: Step, claim: Claim, call: () => Promise<T>): Promise<SendResult<T>> {
  const { db, clock } = ctx;
  const result = await settle(call);
  const at = clock.now();
  if (result.ok) return { ok: true, value: result.value, at };
  const facts = factsOf(result.error);
  const name = target.person.fullName;
  db.transaction((tx) => {
    if (step === "invite" && facts.kind === "limit_hit") {
      finishAction(tx, claim.actionId, { status: "planned", errorKind: facts.kind, error: facts.message }, at);
      logEvent(tx, { level: "warning", campaignId: target.campaign.id, prospectId: target.prospect.id, message: `Invite to ${name} refused: LinkedIn's invitation limit` }, at);
      raiseFor(tx, ctx.settings, facts, at);
      return;
    }
    finishAction(
      tx,
      claim.actionId,
      { status: "unknown", errorKind: facts.kind, error: facts.message, screenshotPath: facts.screenshot },
      at,
    );
    logEvent(
      tx,
      {
        level: "warning",
        campaignId: target.campaign.id,
        prospectId: target.prospect.id,
        message: `${STEP_WORDS[step]} to ${name}: result unknown; LinkedIn will be checked before anything else is done for them`,
      },
      at,
    );
    raiseFor(tx, ctx.settings, facts, at);
    if (facts.kind === "unexpected") checkUnexpectedStreak(tx, at);
  });
  return { ok: false };
}

// ---------------------------------------------------------------- prospect moves

/**
 * Moves the prospect through the lifecycle; throws on a move it forbids. When the stored stage is no
 * longer the one the prospect had when the work was picked, the user changed it while the app was
 * working on it (paused, moved, rejected or closed it in the app): the move is skipped with a warning
 * and the user's stage stands. The caller still finishes its ledger row as usual.
 */
function move(db: Conn, target: Target, to: ProspectStage, changes: ProspectChanges, at: Date, message: string | null, level: "info" | "warning" = "info"): void {
  const current = db.select({ stage: prospects.stage }).from(prospects).where(eq(prospects.id, target.prospect.id)).get();
  if (current === undefined) throw new Error(`prospect ${target.prospect.id} is gone`);
  if (current.stage !== target.prospect.stage) {
    const would = message ?? `it would have moved to ${to.replace(/_/g, " ")}`;
    logEvent(db, { level: "warning", campaignId: target.campaign.id, prospectId: target.prospect.id, message: `${changedMeanwhile(target)} (${would})` }, at);
    return;
  }
  assertMove(current.stage, to);
  db.update(prospects)
    .set({ ...changes, stage: to })
    .where(eq(prospects.id, target.prospect.id))
    .run();
  if (message !== null) {
    logEvent(db, { level, campaignId: target.campaign.id, prospectId: target.prospect.id, message }, at);
  }
}

function changedMeanwhile(target: Target): string {
  return `${target.person.fullName} was changed while the app was working on it; left as it is`;
}

function needsReview(db: Conn, target: Target, reason: string, at: Date): void {
  move(db, target, "needs_review", { reviewReason: reason }, at, `${target.person.fullName} needs review: ${reason}`, "warning");
}

function randomHours(random: RandomSource, min: number, max: number): number {
  const low = Math.min(min, max);
  return low + random() * (Math.max(min, max) - low);
}

/** Records an observed acceptance and schedules the first message. */
function accept(ctx: StepContext, db: Conn, target: Target, at: Date, how: string): void {
  const { campaign } = target;
  const hours = randomHours(ctx.random, campaign.acceptToMessageMinHours, campaign.acceptToMessageMaxHours);
  move(
    db,
    target,
    "accepted",
    { acceptanceObservedAt: at, nextActionAt: addDelay(ctx.settings, campaign.delayPolicy, at, hours) },
    at,
    `${target.person.fullName} accepted the invitation${how}`,
  );
}

// ---------------------------------------------------------------- identity and texts

type Check = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The member id a page showed must match the person's, and no other person may have it
 * (decision 30). A person without one gets it stored.
 *
 * A profile that shows no member id holds the prospect for review. The live profile parser reads
 * the id from the top card's Message link, so this depends on that link being on the page: a
 * profile LinkedIn draws without it holds every such prospect, whatever else the page shows.
 */
function checkMemberId(db: Conn, target: Target, shown: string | null): Check {
  if (shown === null) return { ok: false, reason: "the page shows no member id" };
  const stored = db.select({ memberId: people.memberId }).from(people).where(eq(people.id, target.person.id)).get();
  if (stored?.memberId != null && stored.memberId !== shown) {
    return { ok: false, reason: `the page shows member id ${shown}, not the stored ${stored.memberId}` };
  }
  const other = db
    .select({ id: people.id, fullName: people.fullName })
    .from(people)
    .where(and(eq(people.memberId, shown), ne(people.id, target.person.id)))
    .get();
  if (other !== undefined) return { ok: false, reason: `same member as person ${other.id} (${other.fullName})` };
  if (stored?.memberId == null) db.update(people).set({ memberId: shown }).where(eq(people.id, target.person.id)).run();
  return { ok: true };
}

function templateValues({ person, prospect }: Target): TemplateValues {
  // Only the stored first name: the full name's first word may be a title ("Dott."). Without one,
  // `{{first_name}}` stays unresolved and the prospect is held for review rather than greeted wrongly.
  const firstName = person.firstName?.trim() || null;
  return {
    first_name: firstName,
    company: person.company,
    title: person.title,
    location: person.location,
    industry: person.industryEvidence?.value ?? null,
    ai_line: prospect.aiLine,
  };
}

function renderProblem(what: string, result: Extract<RenderResult, { ok: false }>): string {
  const variables = result.variables.length > 0 ? ` (${result.variables.join(", ")})` : "";
  return `${what} could not be written: ${result.problem.replace(/_/g, " ")}${variables}`;
}

/** The text a step sends: the one an earlier claim froze, else a fresh render. */
function textFor(db: Conn, target: Target, step: Step, template: string, what: string, maxLength?: number): { ok: true; text: string | null } | { ok: false; reason: string } {
  const frozen = frozenText(db, step, target.prospect.id);
  if (frozen.frozen) return { ok: true, text: frozen.text };
  const rendered = renderTemplate(template, templateValues(target), maxLength === undefined ? undefined : { maxLength });
  return rendered.ok ? { ok: true, text: rendered.text } : { ok: false, reason: renderProblem(what, rendered) };
}

function personRef(target: Target, memberId: string): PersonRef {
  return { publicId: target.person.publicId, memberId };
}

const idle = (did: string): StepOutcome => ({ did, touchedLinkedIn: false });
const loaded = (did: string): StepOutcome => ({ did, touchedLinkedIn: true });

/**
 * What a handler does with a refused claim (an invite first turns a suppression into a rejection).
 * A campaign paused or a prospect moved by the user while a read was in flight is the user's choice:
 * a log line only, and the prospect stays as the user set it.
 */
function refused(db: Conn, target: Target, step: Step, refusal: ClaimRefusal, at: Date): void {
  const where = { campaignId: target.campaign.id, prospectId: target.prospect.id };
  if (refusal === "campaign_not_running") {
    const now = db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, target.campaign.id)).get();
    const status = now === undefined ? "gone" : `now ${now.status}`;
    logEvent(db, { ...where, message: `${STEP_WORDS[step]} to ${target.person.fullName} not sent: the campaign is ${status}` }, at);
    return;
  }
  if (refusal === "stage_changed") {
    logEvent(db, { ...where, level: "warning", message: `${changedMeanwhile(target)} (${STEP_WORDS[step].toLowerCase()} not sent)` }, at);
    return;
  }
  if (refusal === "too_many_attempts") {
    needsReview(db, target, `tried ${MAX_STEP_ATTEMPTS} times without a confirmed result`, at);
    return;
  }
  needsReview(db, target, `the step could not be claimed (${refusal.replace(/_/g, " ")})`, at);
}

/**
 * True when it is no longer working time. Asked immediately before every claim, with the settings
 * read again: the tick checked the window when it started, but the read before the claim may have
 * returned much later (the laptop slept while the page loaded). The caller then claims nothing,
 * moves nothing and returns; the next tick inside the window starts over with a fresh read.
 */
function outsideWorkingWindow(ctx: StepContext): boolean {
  return !isInWorkingWindow(getSettings(ctx.db), ctx.clock.now());
}

const afterHours = (label: string, name: string): StepOutcome => loaded(`${label}: working window closed before ${name} could be claimed`);

// ---------------------------------------------------------------- handlers

const CONNECTABLE: ReadonlySet<Profile["connectionState"]> = new Set(["can_connect", "connect_in_more"]);

export async function inviteStep(ctx: StepContext, target: Target): Promise<StepOutcome> {
  const { db, clock, driver } = ctx;
  const { person, prospect, campaign } = target;
  const name = person.fullName;

  // Suppression gate: nothing is loaded for a person who must not be contacted.
  const contactedElsewhere = person.contactedProspectId !== null && person.contactedProspectId !== prospect.id;
  if (person.doNotContact || contactedElsewhere) {
    const why = person.doNotContact ? "marked do not contact" : "already contacted from another campaign";
    const at = clock.now();
    db.transaction((tx) => move(tx, target, "rejected", { closedAt: at }, at, `${name} not invited: ${why}`));
    return idle(`invite: ${name} not invited (${why})`);
  }

  // The note frozen by an earlier claim (null included) wins; else the campaign's, if it has one.
  let noteText: string | null = null;
  const template = campaign.inviteNote ?? "";
  const frozen = frozenText(db, "invite", prospect.id);
  if (frozen.frozen) {
    noteText = frozen.text;
  } else if (template.trim() !== "") {
    const note = textFor(db, target, "invite", template, "The invite note", INVITE_NOTE_MAX);
    if (!note.ok) {
      const at = clock.now();
      db.transaction((tx) => needsReview(tx, target, note.reason, at));
      return idle(`invite: ${name} needs review`);
    }
    noteText = note.text;
  }

  const viewed = await read(ctx, "profile_view", target, () => driver.viewProfile(person.publicId));
  if (!viewed.ok) return loaded(`invite: profile of ${name} not read`);
  const profile = viewed.value;

  let memberId: string | null = null;
  const ready = db.transaction((tx): Check => {
    const at = clock.now();
    const identity = checkMemberId(tx, target, profile.memberId);
    if (!identity.ok) {
      needsReview(tx, target, identity.reason, at);
      return identity;
    }
    if (!CONNECTABLE.has(profile.connectionState)) {
      const reason = `the profile shows ${profile.connectionState.replace(/_/g, " ")}, not Connect`;
      needsReview(tx, target, reason, at);
      return { ok: false, reason };
    }
    memberId = profile.memberId;
    return { ok: true };
  });
  if (!ready.ok || memberId === null) return loaded(`invite: ${name} needs review`);

  if (outsideWorkingWindow(ctx)) return afterHours("invite", name);
  const claimed = claimStep(db, { step: "invite", prospectId: prospect.id, text: noteText }, clock.now());
  if (!claimed.ok) {
    const at = clock.now();
    db.transaction((tx) => {
      if (claimed.refusal === "suppressed" || claimed.refusal === "do_not_contact") {
        move(tx, target, "rejected", { closedAt: at }, at, `${name} not invited: ${claimed.refusal.replace(/_/g, " ")}`);
      } else {
        refused(tx, target, "invite", claimed.refusal, at);
      }
    });
    return loaded(`invite: ${name} not claimed (${claimed.refusal})`);
  }

  const ref = personRef(target, memberId);
  const sent = await send(ctx, target, "invite", claimed.claim, () => driver.sendInvite(ref, claimed.claim.text));
  if (!sent.ok) return loaded(`invite: ${name} not confirmed`);
  const result = sent.value;
  db.transaction((tx) => {
    if (result === "sent") {
      finishAction(tx, claimed.claim.actionId, { status: "done" }, sent.at);
      move(tx, target, "invited", { invitedAt: sent.at, nextActionAt: null }, sent.at, `Invite sent to ${name}`);
    } else {
      finishAction(tx, claimed.claim.actionId, { status: "failed", errorKind: result }, sent.at);
      needsReview(tx, target, `LinkedIn did not take the invite: ${result.replace(/_/g, " ")}`, sent.at);
    }
  });
  return loaded(result === "sent" ? `invite: sent to ${name}` : `invite: ${name} ${result}`);
}

export interface ConnectionsTarget extends Target {
  /** True while the prospect has an unknown step row to reconcile first. */
  readonly awaitingReconcile: boolean;
}

export async function connectionsCheckStep(ctx: StepContext, invited: () => readonly ConnectionsTarget[]): Promise<StepOutcome> {
  const { db, clock, driver } = ctx;
  const listed = await read(ctx, "connections_check", null, () => driver.listRecentConnections());
  if (!listed.ok) return loaded("connections check: not read");
  const cards = listed.value;
  let accepted = 0;
  for (const target of invited()) {
    if (target.awaitingReconcile) continue;
    const { person } = target;
    const card = cards.find(
      (c) => (person.memberId !== null && c.memberId === person.memberId) || c.publicId === person.publicId,
    );
    if (card === undefined) continue;
    const at = clock.now();
    db.transaction((tx) => {
      if (card.memberId !== null) {
        const identity = checkMemberId(tx, target, card.memberId);
        if (!identity.ok) {
          needsReview(tx, target, identity.reason, at);
          return;
        }
      }
      accept(ctx, tx, target, at, "");
      accepted += 1;
    });
  }
  return loaded(`connections check: ${accepted} accepted`);
}

/** The thread check before a message (decision 29). Null when the sequence may continue. */
async function threadBeforeSend(
  ctx: StepContext,
  target: Target,
  memberId: string,
  sentSoFar: readonly string[],
  label: string,
): Promise<{ readonly done: StepOutcome } | { readonly userMessages: number; readonly messageCount: number }> {
  const { db, clock, driver } = ctx;
  const { person, prospect } = target;
  const name = person.fullName;
  const thread = await read(ctx, "thread_check", target, () => driver.readThread({ memberId, publicId: person.publicId }));
  if (!thread.ok) return { done: loaded(`${label}: thread of ${name} not read`) };
  // The invite note is accepted whether or not LinkedIn shows it in the conversation (judgeThread
  // matches the user's messages with and without it). Milestone 4 must make this exact once the
  // live site shows which it is: accepting both lets a hand-sent copy of the note pass as the app's.
  const verdict = judgeThread(thread.value, { inviteNote: prospect.inviteNoteSent, messages: sentSoFar });
  const at = clock.now();
  switch (verdict.verdict) {
    case "clear":
      // The send passes this count to the driver, which refuses if the conversation changed since.
      return { userMessages: verdict.userMessages, messageCount: thread.value.messages.length };
    case "replied":
      db.transaction((tx) =>
        move(tx, target, "stopped", { stopReason: "replied", replyDetectedAt: at, closedAt: at, nextActionAt: null }, at, `${name} replied; sequence stopped`),
      );
      return { done: loaded(`${label}: ${name} replied`) };
    case "manual_takeover":
      db.transaction((tx) =>
        move(tx, target, "stopped", { stopReason: "manual_takeover", closedAt: at, nextActionAt: null }, at, `You wrote to ${name} yourself; sequence stopped`),
      );
      return { done: loaded(`${label}: ${name} taken over by hand`) };
    default: {
      const _exhaustive: never = verdict;
      throw new Error(`unknown verdict ${String(_exhaustive)}`);
    }
  }
}

function afterFirstMessage(ctx: StepContext, target: Target, sentAt: Date, at: Date): ProspectChanges {
  const { campaign } = target;
  const hours = randomHours(ctx.random, campaign.followUpDelayMinHours, campaign.followUpDelayMaxHours);
  return { firstMessageSentAt: sentAt, nextActionAt: addDelay(ctx.settings, campaign.delayPolicy, at, hours) };
}

async function messageStep(ctx: StepContext, target: Target, step: "message1" | "followup"): Promise<StepOutcome> {
  const { db, clock, driver } = ctx;
  const { person, prospect, campaign } = target;
  const name = person.fullName;
  const label = step === "message1" ? "first message" : "follow-up";

  const memberId = person.memberId;
  const sentSoFar = step === "message1" ? [] : [prospect.firstMessageSent];
  if (memberId === null || sentSoFar.some((text) => text === null)) {
    const reason = memberId === null ? "the person's member id is not known" : "no first message is recorded";
    const at = clock.now();
    db.transaction((tx) => needsReview(tx, target, reason, at));
    return idle(`${label}: ${name} needs review`);
  }

  const check = await threadBeforeSend(ctx, target, memberId, sentSoFar.filter((t): t is string => t !== null), label);
  if ("done" in check) return check.done;

  // A campaign without a follow-up still reads the thread first, so a reply before the follow-up
  // would have been due is seen (the Stats screen counts those).
  if (step === "followup" && campaign.followUp.trim() === "") {
    const at = clock.now();
    db.transaction((tx) => move(tx, target, "completed", { closedAt: at, nextActionAt: null }, at, `Sequence completed for ${name}: the campaign has no follow-up`));
    return loaded(`follow-up: none for ${name}; completed`);
  }

  const template = step === "message1" ? campaign.firstMessage : campaign.followUp;
  const text = textFor(db, target, step, template, step === "message1" ? "The first message" : "The follow-up");
  if (!text.ok) {
    const at = clock.now();
    db.transaction((tx) => needsReview(tx, target, text.reason, at));
    return loaded(`${label}: ${name} needs review`);
  }
  if (outsideWorkingWindow(ctx)) return afterHours(label, name);
  const claimed = claimStep(db, { step, prospectId: prospect.id, text: text.text, detail: { userMessagesBefore: check.userMessages } }, clock.now());
  if (!claimed.ok) {
    const at = clock.now();
    db.transaction((tx) => refused(tx, target, step, claimed.refusal, at));
    return loaded(`${label}: ${name} not claimed (${claimed.refusal})`);
  }
  const body = claimed.claim.text;
  if (body === null) throw new Error(`claimed ${step} for prospect ${prospect.id} has no text`);
  const expected = { messageCount: check.messageCount };
  const sent = await send(ctx, target, step, claimed.claim, () => driver.sendMessage(personRef(target, memberId), body, expected));
  if (!sent.ok) return loaded(`${label}: ${name} not confirmed`);
  if (sent.value === "thread_changed") {
    // Nothing was sent: the conversation changed after it was judged. The next tick reads it again.
    db.transaction((tx) => {
      finishAction(tx, claimed.claim.actionId, { status: "planned", errorKind: "thread_changed" }, sent.at);
      logEvent(tx, { campaignId: campaign.id, prospectId: prospect.id, message: `${STEP_WORDS[step]} to ${name} not sent: the conversation changed just before sending; it will be read again` }, sent.at);
    });
    return loaded(`${label}: ${name} conversation changed`);
  }
  db.transaction((tx) => {
    finishAction(tx, claimed.claim.actionId, { status: "done" }, sent.at);
    if (step === "message1") {
      move(tx, target, "message_sent", afterFirstMessage(ctx, target, sent.at, sent.at), sent.at, `First message sent to ${name}`);
    } else {
      move(tx, target, "completed", { followUpSentAt: sent.at, closedAt: sent.at, nextActionAt: null }, sent.at, `Follow-up sent to ${name}`);
    }
  });
  return loaded(`${label}: sent to ${name}`);
}

export const firstMessageStep = (ctx: StepContext, target: Target) => messageStep(ctx, target, "message1");
export const followUpStep = (ctx: StepContext, target: Target) => messageStep(ctx, target, "followup");

export async function withdrawStep(ctx: StepContext, target: Target): Promise<StepOutcome> {
  const { db, clock, driver } = ctx;
  const { person, prospect } = target;
  const name = person.fullName;
  const viewed = await read(ctx, "profile_view", target, () => driver.viewProfile(person.publicId));
  if (!viewed.ok) return loaded(`withdraw: profile of ${name} not read`);
  const profile = viewed.value;

  type Next = { readonly kind: "done"; readonly did: string } | { readonly kind: "withdraw"; readonly memberId: string };
  const next = db.transaction((tx): Next => {
    const at = clock.now();
    const identity = checkMemberId(tx, target, profile.memberId);
    if (!identity.ok || profile.memberId === null) {
      needsReview(tx, target, identity.ok ? "the page shows no member id" : identity.reason, at);
      return { kind: "done", did: `withdraw: ${name} needs review` };
    }
    switch (profile.connectionState) {
      case "connected":
        // Decision 33: the acceptance fell off the connections page during downtime.
        accept(ctx, tx, target, at, " (found when about to withdraw it)");
        return { kind: "done", did: `withdraw: ${name} had accepted` };
      case "pending":
        return { kind: "withdraw", memberId: profile.memberId };
      case "can_connect":
      case "connect_in_more":
        move(tx, target, "withdrawn", { closedAt: at, nextActionAt: null }, at, `Invitation to ${name} closed: nothing was left to withdraw`);
        return { kind: "done", did: `withdraw: nothing pending for ${name}` };
      default:
        needsReview(tx, target, `the profile shows ${profile.connectionState.replace(/_/g, " ")} when withdrawing`, at);
        return { kind: "done", did: `withdraw: ${name} needs review` };
    }
  });
  if (next.kind === "done") return loaded(next.did);

  if (outsideWorkingWindow(ctx)) return afterHours("withdraw", name);
  const claimed = claimStep(db, { step: "withdraw", prospectId: prospect.id, text: null }, clock.now());
  if (!claimed.ok) {
    const at = clock.now();
    db.transaction((tx) => refused(tx, target, "withdraw", claimed.refusal, at));
    return loaded(`withdraw: ${name} not claimed (${claimed.refusal})`);
  }
  const ref = personRef(target, next.memberId);
  const sent = await send(ctx, target, "withdraw", claimed.claim, () => driver.withdrawInvite(ref));
  if (!sent.ok) return loaded(`withdraw: ${name} not confirmed`);
  const result = sent.value;
  db.transaction((tx) => {
    if (result === "withdrawn") {
      finishAction(tx, claimed.claim.actionId, { status: "done" }, sent.at);
      move(tx, target, "withdrawn", { closedAt: sent.at, nextActionAt: null }, sent.at, `Invitation to ${name} withdrawn`);
    } else {
      finishAction(tx, claimed.claim.actionId, { status: "failed", errorKind: result }, sent.at);
      needsReview(tx, target, "LinkedIn showed no pending invitation to withdraw", sent.at);
    }
  });
  return loaded(result === "withdrawn" ? `withdraw: ${name} withdrawn` : `withdraw: ${name} not pending`);
}

// ---------------------------------------------------------------- reconcile

/** An unknown invite older than this is never retried, whatever the profile shows. */
const INVITE_RETRY_MAX_AGE_MS = 14 * DAY_MS;

/**
 * Whether an unknown invite whose profile shows Connect may be tried again. If the invite did go out
 * and the user withdrew it by hand during a long downtime, the profile shows Connect again; LinkedIn
 * blocks re-inviting for about three weeks after a withdrawal, and a second invite would reach the
 * person twice. Only a claim younger than 14 days is retried; one with no start time never is.
 */
function youngEnoughToRetry(row: ActionRow, at: Date): boolean {
  return row.startedAt !== null && at.getTime() - row.startedAt.getTime() < INVITE_RETRY_MAX_AGE_MS;
}

export async function reconcileStep(ctx: StepContext, target: Target, row: ActionRow): Promise<StepOutcome> {
  const { db, clock, driver } = ctx;
  const { person, prospect } = target;
  const name = person.fullName;
  const step = stepOfKey(row.idempotencyKey);
  if (step === null) throw new Error(`${row.idempotencyKey} is not a step row`);
  const claimedAt = row.startedAt ?? clock.now();
  const policy: OtherReadFailure = { kind: "reconcile", row };

  if (step === "invite" || step === "withdraw") {
    const viewed = await read(ctx, "profile_view", target, () => driver.viewProfile(person.publicId), policy);
    if (!viewed.ok) return loaded(`reconcile ${step}: profile of ${name} not read`);
    const profile = viewed.value;
    db.transaction((tx) => {
      const at = clock.now();
      const identity = checkMemberId(tx, target, profile.memberId);
      if (!identity.ok) {
        needsReview(tx, target, identity.reason, at);
        return;
      }
      const state = profile.connectionState;
      const gone = state === "can_connect" || state === "connect_in_more";
      if (step === "invite" && state === "pending") {
        finishAction(tx, row.id, { status: "done" }, at);
        move(tx, target, "invited", { invitedAt: claimedAt, nextActionAt: null }, at, `Invite sent to ${name} (confirmed on LinkedIn after an unknown result)`);
      } else if (step === "invite" && gone && !youngEnoughToRetry(row, at)) {
        needsReview(tx, target, "the invite's result is unknown and too old to retry safely: it may have gone out and been withdrawn since", at);
      } else if (step === "invite" && gone) {
        finishAction(tx, row.id, { status: "planned" }, at);
        logEvent(tx, { campaignId: target.campaign.id, prospectId: prospect.id, message: `Invite to ${name} had not gone out; it will be tried again` }, at);
      } else if (step === "withdraw" && state === "pending") {
        finishAction(tx, row.id, { status: "planned" }, at);
        logEvent(tx, { campaignId: target.campaign.id, prospectId: prospect.id, message: `Withdrawal of the invitation to ${name} had not happened; it will be tried again` }, at);
      } else if (step === "withdraw" && gone) {
        finishAction(tx, row.id, { status: "done" }, at);
        move(tx, target, "withdrawn", { closedAt: at, nextActionAt: null }, at, `Invitation to ${name} withdrawn (confirmed on LinkedIn after an unknown result)`);
      } else {
        needsReview(tx, target, `the ${step === "invite" ? "invite" : "withdrawal"} result is unknown and the profile now shows ${state.replace(/_/g, " ")}`, at);
      }
    });
    return loaded(`reconcile ${step}: ${name}`);
  }

  // A message: judged by count (decision 28).
  const frozen = step === "message1" ? prospect.firstMessageSent : prospect.followUpSent;
  const before = row.detail?.["userMessagesBefore"];
  const memberId = person.memberId;
  if (frozen === null || typeof before !== "number" || !Number.isInteger(before) || before < 0 || memberId === null) {
    const at = clock.now();
    db.transaction((tx) => needsReview(tx, target, `the ${step === "message1" ? "first message" : "follow-up"} result is unknown and cannot be checked`, at));
    return idle(`reconcile ${step}: ${name} needs review`);
  }
  const thread = await read(ctx, "thread_check", target, () => driver.readThread({ memberId, publicId: person.publicId }), policy);
  if (!thread.ok) return loaded(`reconcile ${step}: thread of ${name} not read`);
  const verdict = judgeSend(thread.value, frozen, before);
  db.transaction((tx) => {
    const at = clock.now();
    switch (verdict) {
      case "sent":
        finishAction(tx, row.id, { status: "done" }, at);
        if (step === "message1") {
          move(tx, target, "message_sent", afterFirstMessage(ctx, target, claimedAt, at), at, `First message sent to ${name} (confirmed in the conversation after an unknown result)`);
        } else {
          move(tx, target, "completed", { followUpSentAt: claimedAt, closedAt: at, nextActionAt: null }, at, `Follow-up sent to ${name} (confirmed in the conversation after an unknown result)`);
        }
        return;
      case "not_sent":
        finishAction(tx, row.id, { status: "planned" }, at);
        logEvent(tx, { campaignId: target.campaign.id, prospectId: prospect.id, message: `${STEP_WORDS[step]} to ${name} had not gone out; it will be tried again` }, at);
        return;
      case "unclear":
        needsReview(tx, target, `the conversation does not show clearly whether the ${step === "message1" ? "first message" : "follow-up"} went out`, at);
        return;
      default: {
        const _exhaustive: never = verdict;
        throw new Error(`unknown verdict ${String(_exhaustive)}`);
      }
    }
  });
  return loaded(`reconcile ${step}: ${name} ${verdict.replace(/_/g, " ")}`);
}
