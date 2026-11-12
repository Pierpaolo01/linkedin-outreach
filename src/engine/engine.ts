/**
 * The engine (spec section 6, decisions 25–37): each tick does at most one piece of due work,
 * worked out from the database alone. Nothing is queued; a new engine carries on from the ledger.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, like, lte, max, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getSettings, type Settings } from "../config/settings";
import type { Db } from "../db/index";
import { actions, campaigns, people, prospects, type ProspectStage } from "../db/schema";
import { checkBudget, type BudgetKind } from "./budget";
import { closeInterruptedRows, STEP_STAGE, stepOfKey, type ActionRow, type Step } from "./ledger";
import { createPacer, type Pacer } from "./pacing";
import type { Engine, EngineDeps, TickResult } from "./ports";
import { activeSafetyStop } from "./safetyStop";
import {
  connectionsCheckStep,
  firstMessageStep,
  followUpStep,
  inviteStep,
  reconcileStep,
  withdrawStep,
  type ConnectionsTarget,
  WINDOW_END_MARGIN_MS,
  type StepContext,
  type StepOutcome,
  type Target,
} from "./steps";
import { endOfWorkingWindow, isInWorkingWindow, nextWorkingInstant } from "./workingWindow";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const IDLE_MS = MINUTE_MS;
const CONNECTIONS_CHECK_EVERY_MS = 3 * 60 * MINUTE_MS;
/** After work that did not load LinkedIn, the next tick may run almost at once. */
const AFTER_LOCAL_WORK_MS = 1_000;
/** A tick called while another is in flight on the same engine asks to be called again this much later. */
const OVERLAP_RETRY_MS = 1_000;

export type DueWork =
  | { readonly kind: "reconcile"; readonly target: Target; readonly row: ActionRow }
  | { readonly kind: "connections_check" }
  | { readonly kind: "followup" | "message1" | "withdraw" | "invite"; readonly target: Target };

/**
 * Whoever runs the engine must build a new driver, and a new engine on it, after the user's
 * `resumeSafetyStop`: a driver latches on a login wall, checkpoint or restriction (decision 18) and
 * rethrows that error on every later call, so the old one would raise the stop again at once.
 */
export function createEngine(deps: EngineDeps): Engine {
  const pacer = createPacer(deps.random);
  // A second tick while one is in flight would close the first's in-progress row as interrupted,
  // reconcile it before the click lands and send the step twice. It does nothing instead.
  let inFlight = false;
  return {
    async tick() {
      if (inFlight) return { did: null, wakeAt: new Date(deps.clock.now().getTime() + OVERLAP_RETRY_MS) };
      inFlight = true;
      try {
        return await tick(deps, pacer);
      } finally {
        inFlight = false;
      }
    },
  };
}

async function tick(deps: EngineDeps, pacer: Pacer): Promise<TickResult> {
  const { db, clock } = deps;
  const now = clock.now();
  const settings = getSettings(db);
  const idle = (wakeAt: Date): TickResult => ({ did: null, wakeAt });

  const closed = closeInterruptedRows(db, now);
  pacer.start(db, settings, { now, foundInProgress: closed > 0 });
  if (activeSafetyStop(db) !== null) return idle(new Date(now.getTime() + IDLE_MS));
  if (!isInWorkingWindow(settings, now)) return idle(nextWorkingInstant(settings, now));
  const windowEnd = endOfWorkingWindow(settings, now);
  if (windowEnd.getTime() - now.getTime() <= WINDOW_END_MARGIN_MS) return idle(nextWorkingInstant(settings, windowEnd));
  const gate = pacer.notBefore();
  if (gate !== null && now < gate) return idle(gate);

  const work = pickDueWork(db, settings, now);
  if (work === null) return idle(new Date(now.getTime() + IDLE_MS));

  const ctx: StepContext = { db, driver: deps.driver, clock, random: deps.random, settings };
  const outcome = await run(ctx, work);
  const after = clock.now();
  const wakeAt = outcome.touchedLinkedIn
    ? pacer.afterAction(settings, after)
    : new Date(Math.max(after.getTime(), now.getTime()) + AFTER_LOCAL_WORK_MS);
  return { did: outcome.did, wakeAt };
}

function run(ctx: StepContext, work: DueWork): Promise<StepOutcome> {
  switch (work.kind) {
    case "reconcile":
      return reconcileStep(ctx, work.target, work.row);
    case "connections_check":
      return connectionsCheckStep(ctx, () => invitedTargets(ctx.db));
    case "followup":
      return followUpStep(ctx, work.target);
    case "message1":
      return firstMessageStep(ctx, work.target);
    case "withdraw":
      return withdrawStep(ctx, work.target);
    case "invite":
      return inviteStep(ctx, work.target);
    default: {
      const _exhaustive: never = work;
      throw new Error(`unknown work ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------- picking due work

/** Whether every budget in `kinds` is open; each budget is asked at most once per tick. */
type BudgetGate = (kinds: readonly BudgetKind[]) => boolean;

function budgetGate(db: Db, settings: Settings, now: Date): BudgetGate {
  const answers = new Map<BudgetKind, boolean>();
  const allowed = (kind: BudgetKind): boolean => {
    const known = answers.get(kind);
    if (known !== undefined) return known;
    const answer = checkBudget(db, settings, kind, now).allowed;
    answers.set(kind, answer);
    return answer;
  };
  return (kinds) => kinds.every(allowed);
}

/** Unknown step rows that still decide the prospect's current stage (the step of that stage). */
function unknownStepRows(db: Db): Map<number, ActionRow[]> {
  const rows = db
    .select()
    .from(actions)
    .where(and(eq(actions.status, "unknown"), isNotNull(actions.prospectId)))
    .orderBy(asc(actions.startedAt), asc(actions.id))
    .all();
  const byProspect = new Map<number, ActionRow[]>();
  for (const row of rows) {
    if (row.prospectId === null || stepOfKey(row.idempotencyKey) === null) continue;
    byProspect.set(row.prospectId, [...(byProspect.get(row.prospectId) ?? []), row]);
  }
  return byProspect;
}

/** The stage a step row's prospect must be in for the row to be reconciled. */
function stepStage(row: ActionRow): ProspectStage | null {
  const step = stepOfKey(row.idempotencyKey);
  return step === null ? null : STEP_STAGE[step];
}

/** The unknown row that must be reconciled before anything else happens to this prospect, if any. */
function rowToReconcile(rows: ReadonlyMap<number, readonly ActionRow[]>, prospect: Target["prospect"]): ActionRow | undefined {
  return rows.get(prospect.id)?.find((row) => stepStage(row) === prospect.stage);
}

function targets(db: Db, where: SQL | undefined): Target[] {
  return db
    .select({ prospect: prospects, campaign: campaigns, person: people })
    .from(prospects)
    .innerJoin(campaigns, eq(campaigns.id, prospects.campaignId))
    .innerJoin(people, eq(people.id, prospects.personId))
    .where(where)
    .orderBy(asc(prospects.id))
    .all();
}

const dueBy = (now: Date) => or(isNull(prospects.nextActionAt), lte(prospects.nextActionAt, now));

function invitedTargets(db: Db): ConnectionsTarget[] {
  const unknown = unknownStepRows(db);
  return targets(db, and(eq(prospects.stage, "invited"), ne(campaigns.status, "archived"))).map((target) => ({
    ...target,
    awaitingReconcile: rowToReconcile(unknown, target.prospect) !== undefined,
  }));
}

/** A prospect that could be worked on, as little of it as choosing between them needs. */
interface Candidate {
  readonly prospectId: number;
  readonly campaignId: number;
  /** When it became due for this step (ms); older goes first within a campaign. */
  readonly age: number;
}

/**
 * Prospects of running campaigns in `stage` that match `where`, leaving out those with an unknown
 * row of this stage's step to reconcile first (decision 27).
 */
function candidates(db: Db, unknown: ReadonlyMap<number, readonly ActionRow[]>, stage: ProspectStage, age: SQL<number>, where: SQL | undefined): Candidate[] {
  const blocked = [...unknown]
    .filter(([, rows]) => rows.some((row) => stepStage(row) === stage))
    .map(([prospectId]) => prospectId);
  return db
    .select({ prospectId: prospects.id, campaignId: prospects.campaignId, age })
    .from(prospects)
    .innerJoin(campaigns, eq(campaigns.id, prospects.campaignId))
    .where(and(eq(prospects.stage, stage), eq(campaigns.status, "running"), blocked.length === 0 ? undefined : notInArray(prospects.id, blocked), where))
    .all();
}

/**
 * Campaigns take turns: the campaign whose last row of this step started longest ago goes first
 * (never: first; tie: lowest id), then its oldest due prospect. Returns that prospect, loaded.
 */
function inTurn(db: Db, step: Step, due: readonly Candidate[]): Target | null {
  if (due.length === 0) return null;
  const last = new Map<number, number>();
  const rows = db
    .select({ campaignId: actions.campaignId, started: max(actions.startedAt) })
    .from(actions)
    .where(like(actions.idempotencyKey, `${step}:%`))
    .groupBy(actions.campaignId)
    .all();
  for (const row of rows) if (row.campaignId !== null && row.started !== null) last.set(row.campaignId, row.started.getTime());
  const first = [...due].sort(
    (a, b) =>
      (last.get(a.campaignId) ?? -Infinity) - (last.get(b.campaignId) ?? -Infinity) ||
      a.campaignId - b.campaignId ||
      a.age - b.age ||
      a.prospectId - b.prospectId,
  )[0];
  return first === undefined ? null : (targets(db, eq(prospects.id, first.prospectId))[0] ?? null);
}

/** The candidates' campaigns whose follow-up is blank: at follow-up time they send nothing (decision 41). */
function withoutFollowUp(db: Db, due: readonly Candidate[]): Set<number> {
  const ids = [...new Set(due.map((candidate) => candidate.campaignId))];
  const rows = db.select({ id: campaigns.id, followUp: campaigns.followUp }).from(campaigns).where(inArray(campaigns.id, ids)).all();
  // The same test as the follow-up handler's, so the two agree on what "blank" is.
  return new Set(rows.filter((row) => row.followUp.trim() === "").map((row) => row.id));
}

/** True when some prospect of a campaign that is not archived waits on an invitation. */
function anyInvited(db: Db): boolean {
  const row = db
    .select({ id: prospects.id })
    .from(prospects)
    .innerJoin(campaigns, eq(campaigns.id, prospects.campaignId))
    .where(and(eq(prospects.stage, "invited"), ne(campaigns.status, "archived")))
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * The next piece of due work, or null. Each kind's candidates are looked up before its budgets are
 * asked, so a kind with nothing due costs no budget query; budgets are asked at most once per call.
 */
export function pickDueWork(db: Db, settings: Settings, now: Date): DueWork | null {
  const open = budgetGate(db, settings, now);
  const unknown = unknownStepRows(db);

  // 1. Reconcile: the oldest unknown step row first. Only a row for the prospect's current stage counts:
  // a prospect in needs review, closed, or moved on by the user is not reconciled automatically.
  const toReconcile =
    unknown.size === 0
      ? []
      : targets(db, and(inArray(prospects.id, [...unknown.keys()]), ne(campaigns.status, "archived"), dueBy(now)))
          .flatMap((target) => {
            const row = rowToReconcile(unknown, target.prospect);
            return row === undefined ? [] : [{ target, row }];
          })
          .sort((a, b) => (a.row.startedAt?.getTime() ?? 0) - (b.row.startedAt?.getTime() ?? 0) || a.row.id - b.row.id);
  for (const { target, row } of toReconcile) {
    const step = stepOfKey(row.idempotencyKey);
    const viewsProfile = step === "invite" || step === "withdraw";
    if (!viewsProfile || open(["profile_view"])) return { kind: "reconcile", target, row };
  }

  // 2. Connections check.
  if (anyInvited(db)) {
    const recent = db
      .select({ id: actions.id })
      .from(actions)
      .where(and(eq(actions.type, "connections_check"), gt(actions.startedAt, new Date(now.getTime() - CONNECTIONS_CHECK_EVERY_MS))))
      .get();
    if (recent === undefined) return { kind: "connections_check" };
  }

  // 3. Follow-ups, 4. first messages. Both spend the message budget: when it is closed, neither runs,
  // except a follow-up of a campaign with no follow-up text, which only reads the thread and closes.
  const nextAt = sql<number>`${prospects.nextActionAt}`;
  for (const [step, stage] of [
    ["followup", "message_sent"],
    ["message1", "accepted"],
  ] as const) {
    const due = candidates(db, unknown, stage, nextAt, and(isNotNull(prospects.nextActionAt), lte(prospects.nextActionAt, now)));
    if (due.length === 0) continue;
    const sendsNothing = step === "followup" ? withoutFollowUp(db, due) : new Set<number>();
    const free = due.filter((candidate) => sendsNothing.has(candidate.campaignId));
    const pool = free.length === due.length || open(["message"]) ? due : free;
    const target = inTurn(db, step, pool);
    if (target !== null) return { kind: step, target };
  }

  // 5. Withdrawals of old invitations. Picking one needs only a profile view: the view may find a
  // missed acceptance (decision 33), which must not wait on the withdrawal budget. With that budget
  // closed, a still pending invitation is put off until it opens (withdrawStep).
  const toWithdraw = candidates(
    db,
    unknown,
    "invited",
    sql<number>`${prospects.invitedAt}`,
    and(isNotNull(prospects.invitedAt), dueBy(now), sql`${prospects.invitedAt} + ${campaigns.withdrawAfterDays} * ${DAY_MS} <= ${now.getTime()}`),
  );
  if (toWithdraw.length > 0 && open(["profile_view"])) {
    const target = inTurn(db, "withdraw", toWithdraw);
    if (target !== null) return { kind: "withdraw", target };
  }

  // 6. Invites.
  const toInvite = candidates(db, unknown, "approved", sql<number>`coalesce(${prospects.approvedAt}, ${prospects.foundAt})`, dueBy(now));
  if (toInvite.length > 0 && open(["invite", "profile_view"])) {
    const target = inTurn(db, "invite", toInvite);
    if (target !== null) return { kind: "invite", target };
  }
  return null;
}
