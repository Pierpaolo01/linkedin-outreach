/**
 * The engine simulation's harness (handoff section 5, item 2). It holds the simulated LinkedIn
 * (`FakeWorld`) outside the engine, runs the engine tick by tick on a virtual clock, and kills the
 * "process" at seeded random points: inside any driver operation (`before`, `typed`, `after`) and
 * between two ticks. A kill revokes the driver handle and closes the SQLite connection before it
 * throws, so nothing the dying engine does afterwards (a catch handler included) can reach LinkedIn
 * or the database. Then it reopens the same file, connects a new handle and builds a new engine.
 *
 * While a tick runs, the same hook (at a call's `before` kill point, when no kill landed there)
 * fires the scenario's interventions (a member replies, the user pauses a campaign, closes a
 * prospect, lowers a limit or clears a template, a send fails) and suspends calls the laptop sleeps
 * through (`world.suspendNext`): reads, and sends that start a few minutes before the window closes.
 *
 * It is generic over the engine: tests pass deliberately broken stubs, the real run passes
 * `createEngine`. Nothing here uses a real timer; a seed replays exactly.
 */
import { isNull } from "drizzle-orm";
import { DEFAULT_SETTINGS, type Settings } from "../../config/settings";
import { openDb, type Db, type OpenedDb } from "../../db/index";
import { safetyStops, type StopReason } from "../../db/schema";
import {
  FakeWorld,
  HandleRevoked,
  type DriverHandle,
  type DriverOp,
  type FaultKind,
  type KillPhase,
  type KillPoint,
  type WorldOptions,
} from "../../linkedin/fake/world";
import type { SessionBreak } from "../../linkedin/fake/world";
import type { Clock, Driver, Engine, EngineDeps, RandomSource, TickResult } from "../ports";
import { addDays, inWorkingWindow, isWorkingDay, localDay, windowOn } from "./localTime";
import { currentRun } from "./pieces";

// ---------------------------------------------------------------- seeded randomness and time

/** mulberry32: a small seeded generator in [0, 1). */
export function mulberry32(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function randomBetween(random: RandomSource, min: number, max: number): number {
  return min + random() * (max - min);
}

/** A clock that only moves when told: `sleep` jumps, it never waits. */
export class VirtualClock implements Clock {
  #now: number;

  constructor(start: Date) {
    this.#now = start.getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  async sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`cannot sleep ${ms} ms`);
    this.#now += ms;
  }

  /** Moves forward to `at`; never backwards. */
  advanceTo(at: Date): void {
    if (at.getTime() > this.#now) this.#now = at.getTime();
  }
}

// ---------------------------------------------------------------- what a scenario is

/** The engine under test: its factory, and the user's Resume button. */
export interface EngineModule {
  readonly createEngine: (deps: EngineDeps) => Engine;
  readonly resumeSafetyStop: (db: Db, now: Date) => boolean;
}

export interface CampaignFact {
  readonly key: string;
  readonly id: number;
  readonly inviteNote: string | null;
  readonly firstMessage: string;
  readonly followUp: string;
}

export interface ProspectFact {
  readonly campaign: string;
  readonly prospectId: number;
  /** The `people` row's public id (differs from the world member's for the shared-member-id trap). */
  readonly personPublicId: string;
  readonly firstName: string | null;
  readonly company: string | null;
  readonly addedAt: Date;
}

/**
 * A path a scripted member must end on, checked by assertion 7:
 * - `never_greeted`: no first name is known. No invite note and no message may reach them; they end in needs review.
 * - `stops_on_reply`: in a campaign with no follow-up, they reply after the first message. They get exactly one
 *   message and end stopped, reason replied.
 * - `replies_mid_send`: their reply lands between the app's thread read and its first send (an intervention at
 *   `sendMessage`/`before`). Nothing from the app follows it; they end stopped, reason replied.
 * - `stops_after_kill`: the process is killed during their first message (a forced kill at `phase`), then they
 *   reply or the user writes to them by hand. At most one first message from the app; they end stopped for `reason`.
 * - `send_never_succeeds`: every message send fails before its effect. The app tries at most three times, sends
 *   nothing and holds them for review.
 * - `paused_mid_read`: their campaign is paused while their thread read loads, and resumed later. They are not held
 *   for review, nothing reaches them while it is paused, and they are worked again after it resumes.
 * - `changed_mid_tick`: the user rejects or stops them while their read loads. Nothing reaches them after that
 *   instant, and the user's decision stands.
 * - `send_slept_through`: their `op` starts a few minutes before the window closes and the laptop sleeps through it
 *   (`SendSleep`). Nothing of it lands outside the window; the step goes out inside a later window, and they are
 *   not held for review.
 * - `follow_up_cleared_mid_read`: the user clears their campaign's follow-up while their follow-up thread read
 *   loads, and restores it later. No follow-up comes from that read, and they are not held for review.
 */
export type Expectation =
  | { readonly kind: "never_greeted" }
  | { readonly kind: "stops_on_reply" }
  | { readonly kind: "replies_mid_send" }
  | { readonly kind: "stops_after_kill"; readonly reason: StopReason; readonly phase: KillPhase }
  | { readonly kind: "send_never_succeeds" }
  | { readonly kind: "paused_mid_read" }
  | { readonly kind: "changed_mid_tick"; readonly to: "rejected" | "stopped" }
  | { readonly kind: "send_slept_through"; readonly op: WriteOp }
  | { readonly kind: "follow_up_cleared_mid_read" };

/** What the scenario knows about one world member, for the verdicts. Keyed by the world's public id. */
export interface MemberFact {
  readonly publicId: string;
  readonly memberId: string;
  role: string;
  readonly prospects: ProspectFact[];
  /** Invitations sent before the run (by the app, in an earlier campaign); the world's log does not hold them. */
  preRunInvites: number;
  /** From this instant the member is a suppression trap: any invite or message is a second campaign's contact. */
  trapSince: Date | null;
  doNotContact: boolean;
  /**
   * Scripted with fixed timings so a path is reached in every seed. Random kills and scripted faults
   * never land on a scripted member; only the scenario's forced kills do.
   */
  readonly scripted: boolean;
  readonly expect: Expectation | null;
}

/** The settings in force from `at` on, until the next change. */
export interface SettingsChange {
  readonly at: Date;
  readonly settings: Settings;
}

export interface ScenarioFacts {
  /** The settings now (the last change). */
  settings: Settings;
  /** Every change, oldest first (`applySettings` appends): the verdicts judge each moment by the settings then. */
  readonly settingsHistory: SettingsChange[];
  readonly campaigns: Map<string, CampaignFact>;
  readonly members: Map<string, MemberFact>;
}

/** The settings in force at `at`: the last change at or before it; before any change, the defaults (a new database stores none). */
export function settingsAt(facts: ScenarioFacts, at: Date): Settings {
  let found: Settings = DEFAULT_SETTINGS;
  for (const change of facts.settingsHistory) {
    if (change.at.getTime() > at.getTime()) break;
    found = change.settings;
  }
  return found;
}

export function memberByMemberId(facts: ScenarioFacts, memberId: string): MemberFact | undefined {
  for (const member of facts.members.values()) if (member.memberId === memberId) return member;
  return undefined;
}

export interface SimContext {
  readonly db: Db;
  readonly world: FakeWorld;
  readonly now: Date;
  readonly facts: ScenarioFacts;
}

export interface ScenarioEvent {
  readonly at: Date;
  readonly label: string;
  apply(context: SimContext): void;
}

/** What an intervention may do: change the app's database or the world, and schedule a change for later. */
export interface InterventionContext extends SimContext {
  /** Applies `apply` between two ticks, `afterMs` from now (a change the user makes later). */
  later(afterMs: number, label: string, apply: (context: SimContext) => void): void;
}

/**
 * Something the user or a member does while a tick is running: fired from the driver hook at the
 * `before` kill point of a call of `op` about `target` (a world public id), when no kill landed
 * there and `when` (if given) holds. It fires on the first such call, or on every one with `every`.
 */
export interface Intervention {
  readonly label: string;
  readonly op: DriverOp;
  readonly target: string;
  readonly every?: boolean;
  /** Counted by the verdicts as `settingsChangedMidRead` (a limit or a template changed while a read loads). */
  readonly tag?: "settings_mid_read";
  when?(context: SimContext): boolean;
  apply(context: InterventionContext): void;
}

/** A window of time in which the first read of a scripted member that starts is suspended for `ms` (the laptop sleeps while it loads). */
export interface SuspensionSlot {
  readonly from: Date;
  readonly to: Date;
  readonly ms: number;
}

/** The operations that change something on LinkedIn. */
export type WriteOp = "sendInvite" | "sendMessage" | "withdrawInvite";

/** The read each write's step makes right before it: the profile before an invite or a withdrawal, the thread before a message. */
export const LEAD_IN: Readonly<Record<WriteOp, DriverOp>> = { sendInvite: "viewProfile", sendMessage: "readThread", withdrawInvite: "viewProfile" };

export function isWriteOp(op: DriverOp): op is WriteOp {
  return op === "sendInvite" || op === "sendMessage" || op === "withdrawInvite";
}

/**
 * A write to a fixed (scripted) member that the laptop sleeps through: it starts `startsBeforeEndMs`
 * before the working window closes and takes `ms`. To start it then whenever the engine gets to it,
 * the read right before it (`LEAD_IN`) is stretched to land at that instant (the laptop slept while
 * the page loaded, inside the window); the engine then claims and calls the write, which takes `ms`.
 * Used once, on the first lead-in read about the member while the step is still to do.
 */
export interface SendSleep {
  readonly op: WriteOp;
  readonly target: string;
  readonly startsBeforeEndMs: number;
  readonly ms: number;
}

export interface SuspensionPlan {
  /** Planned reads: each slot suspends one read. No random kill, fault or suspension lands inside a slot. */
  readonly slots: readonly SuspensionSlot[];
  /** Planned writes (see `SendSleep`). */
  readonly sends?: readonly SendSleep[];
  /** Chance that a read of a member who is not scripted is suspended. */
  readonly randomChance: number;
  /** Chance that a write to a member who is not scripted is suspended. Absent: none. */
  readonly randomSendChance?: number;
  /** A random suspension that starts this close to the window's end lasts `lateMs`; any other lasts `otherMs` (a range). */
  readonly lateWithinMs: number;
  readonly lateMs: number;
  readonly otherMs: readonly [number, number];
}

/** The laptop is off: no ticks at all. The process dies at `from` and starts again at `to`. */
export interface Downtime {
  readonly from: Date;
  readonly to: Date;
}

export interface ScheduledFault {
  readonly at: Date;
  readonly op: DriverOp;
  readonly fault: FaultKind;
}

/** LinkedIn shows a checkpoint (or similar) from `at`. The user fixes it when he sees the safety stop, or by `userFixesBy` anyway. */
export interface SessionBreakPlan {
  readonly at: Date;
  readonly kind: SessionBreak;
  readonly userFixesBy: Date;
}

/** A kill the scenario places on purpose. Each fires once. */
export type ForcedKill =
  /** The nth time this op and phase is reached in the whole run, from 1. */
  | { readonly kind: "nth"; readonly op: DriverOp; readonly phase: KillPhase; readonly nth: number }
  /** The first time this op and phase is reached for this member (world public id). */
  | { readonly kind: "member"; readonly op: DriverOp; readonly phase: KillPhase; readonly target: string }
  /** Between two ticks, after the nth completed tick of the run. */
  | { readonly kind: "between"; readonly nth: number }
  /** The first read of this member, at a kill point no other kill took, while their send result is unknown to the engine. */
  | { readonly kind: "reconcile_read"; readonly target: string }
  /** The process started right after the first kill on this member dies at its own first kill point. */
  | { readonly kind: "rekill"; readonly target: string }
  /**
   * `count` kills between ticks, each restart `restartMs` (a range) after the last, from the first
   * resolved tick at which the current run of pieces of work without a break reaches `runAtLeast`.
   * Each restarted process dies after its first resolved tick (usually idle: the pacer's gate).
   */
  | { readonly kind: "burst"; readonly count: number; readonly runAtLeast: number; readonly restartMs: readonly [number, number] };

export interface KillPlan {
  /** Chance of a kill at each kill point of a send (invite, message, withdraw). */
  readonly sendPoint: number;
  /** Chance at each kill point of a read. */
  readonly readPoint: number;
  /** Chance after each tick that resolved. */
  readonly betweenTicks: number;
  /** Chance at a read of someone whose send was killed or timed out and not yet looked at again (a reconcile read). */
  readonly reconcileRead: number;
  /** Chance that a restarted process is killed again at its first kill point (idle ticks before it do not count). */
  readonly quickRekill: number;
  readonly forced?: readonly ForcedKill[];
  /** Past this fraction of the run, every kind of kill not yet delivered is delivered at its next chance. Null: never forced. */
  readonly ensureAfter: number | null;
}

export const NO_KILLS: KillPlan = { sendPoint: 0, readPoint: 0, betweenTicks: 0, reconcileRead: 0, quickRekill: 0, ensureAfter: null };

export const MINIMUM_KEYS = [
  "invites",
  "acceptancesObserved",
  "firstMessages",
  "followUps",
  "withdrawals",
  "stoppedReplied",
  "stoppedManual",
  "needsReview",
  "killsBefore",
  "killsTyped",
  "killsAfter",
  "killsBetween",
  "killsDuringReconcileRead",
  "killsBeforeTickCompleted",
  "reconcileConfirmedSent",
  "reconcileRetried",
  "safetyStopCheckpoint",
  "safetyStopLimit",
  "repliesMidSend",
  "suspendedReadsPlanned",
  "suspendedSendsPlanned",
  "changesMidTick",
  "settingsChangedMidRead",
  "killsOnReplyAndTakeover",
  "killsInBurst",
  "weeksStoppedByWeeklyLimit",
  "fullDaysAfterDowntimeAtLimit",
] as const;
export type MinimumKey = (typeof MINIMUM_KEYS)[number];
export type Minimums = Readonly<Record<MinimumKey, number>>;

export const ZERO_MINIMUMS: Minimums = Object.fromEntries(MINIMUM_KEYS.map((key) => [key, 0])) as Record<MinimumKey, number>;

export interface Scenario {
  readonly name: string;
  readonly start: Date;
  readonly end: Date;
  readonly world: WorldOptions;
  readonly facts: ScenarioFacts;
  /** Runs once on the fresh database and world, at `start`. */
  setup(context: SimContext): void;
  /** Sorted by time. Applied between ticks, never during downtime. */
  readonly events: readonly ScenarioEvent[];
  readonly downtimes: readonly Downtime[];
  readonly faults: readonly ScheduledFault[];
  readonly sessionBreaks: readonly SessionBreakPlan[];
  readonly kills: KillPlan;
  /** Fired while a tick runs (see `Intervention`). */
  readonly interventions?: readonly Intervention[];
  /** Reads and writes the laptop sleeps through. Absent: none. */
  readonly suspensions?: SuspensionPlan;
  /** Spans with no random kill, fault or suspension and no burst (say, the short openings planned send sleeps use). */
  readonly quietSpans?: readonly { readonly from: Date; readonly to: Date }[];
  readonly minimums: Minimums;
  /** Longest wait between two ticks while the process runs, like a runner that polls for new work. */
  readonly pollMs: number;
  /** After a stop the user notices it and presses Resume this many hours later (seeded in the range). */
  readonly userResumeHours: readonly [number, number];
  /**
   * From this instant no kill and no scripted fault: the run's last working day, so a result left
   * unknown has working time to be checked before the run ends. Absent: never quiet.
   */
  readonly quietFrom?: Date;
}

// ---------------------------------------------------------------- what a run records

export type SendKind = "invite" | "message" | "withdraw";

export interface KillRecord {
  readonly at: Date;
  /** Null for a kill between two ticks. */
  readonly op: DriverOp | null;
  readonly phase: KillPhase | "between";
  readonly cause: "random" | "forced" | "ensure" | "reconcile_read" | "rekill" | "downtime" | "burst";
  /** The world public id the interrupted call was about, when it was about one person. */
  readonly target: string | null;
  /**
   * The process was started after an earlier kill and had not yet completed a tick that reached
   * LinkedIn: it died during its first piece of work, usually the check of the unknown result.
   */
  readonly beforeTickCompleted: boolean;
  /** The call was a read of someone whose send result was still unknown to the engine. */
  readonly duringReconcileRead: boolean;
  /** How the harness saw the kill land: the tick rejected, or the handle refused afterwards. */
  verified: "pending" | "rejected" | "revoked" | "swallowed" | "not_revoked";
}

/** A send whose result the engine could not know: killed in the middle, or a scripted timeout. */
export interface UncertainSend {
  readonly at: Date;
  readonly kind: SendKind;
  readonly publicId: string;
  /** Whether LinkedIn received it. */
  readonly effect: boolean;
  readonly via: string;
}

/**
 * Why a call was suspended: `slot`, a planned read (`SuspensionSlot`); `lead_in`, the read before a
 * planned send sleep, stretched to land a few minutes before the window closes; `send_sleep`, that
 * write (`SendSleep`); `random`, a read or a write at random.
 */
export type SuspensionCause = "slot" | "lead_in" | "send_sleep" | "random";

/** A call the laptop slept through. The world stamps what it did (a page load, a send) at `landsAt`, or later. */
export interface Suspension {
  readonly op: DriverOp;
  readonly target: string;
  /** When the app started it: the `before` kill point. */
  readonly startedAt: Date;
  readonly landsAt: Date;
  readonly cause: SuspensionCause;
}

export interface InterventionRecord {
  readonly label: string;
  readonly target: string;
  readonly at: Date;
  /** `fired`: the intervention itself, inside a tick; `later`: a change it scheduled, between ticks. */
  readonly phase: "fired" | "later";
  readonly tag?: Intervention["tag"];
}

/** A call of a send operation that reached the driver (its `before` kill point). */
export interface SendCall {
  readonly op: DriverOp;
  readonly target: string;
  readonly at: Date;
}

export interface UserResume {
  readonly at: Date;
  readonly stopIds: readonly number[];
  readonly reasons: readonly string[];
  /** What `resumeSafetyStop` returned; null when there was no stop to resume (session fixed anyway). */
  readonly resumed: boolean | null;
}

export interface SimRun {
  readonly seed: number;
  readonly scenario: Scenario;
  readonly world: FakeWorld;
  readonly dbFile: string;
  readonly kills: readonly KillRecord[];
  readonly uncertainSends: readonly UncertainSend[];
  readonly userResumes: readonly UserResume[];
  readonly engineErrors: readonly { readonly at: Date; readonly message: string }[];
  readonly harnessFailures: readonly string[];
  readonly interventions: readonly InterventionRecord[];
  readonly suspensions: readonly Suspension[];
  readonly sendCalls: readonly SendCall[];
  /** When each process (engine and driver handle) started: at the start, after each kill or downtime, and after each Resume. */
  readonly processStarts: readonly Date[];
  readonly ticks: number;
  readonly ticksWithWork: number;
  readonly finishedAt: Date;
  readonly wallMs: number;
}

/** Thrown from the kill hook. The engine should never see it resolve a tick. */
export class SimKill extends Error {
  constructor(point: KillPoint) {
    super(`simulation: process killed at ${point.op}/${point.phase}`);
    this.name = "SimKill";
  }
}

const SEND_OPS: ReadonlyMap<DriverOp, SendKind> = new Map([
  ["sendInvite", "invite"],
  ["sendMessage", "message"],
  ["withdrawInvite", "withdraw"],
]);
const RECONCILE_READS: ReadonlySet<DriverOp> = new Set(["viewProfile", "readThread", "listSentInvitations", "listRecentConnections"]);
/** The reads about one member that come before a send, and that a suspension may stretch. */
const MEMBER_READS: ReadonlySet<DriverOp> = new Set(["viewProfile", "readThread"]);
const RESTART_MS: readonly [number, number] = [10_000, 60_000];
const DEFAULT_MAX_TICKS = 300_000;
/** A stretched lead-in read lasts at least this long (longer than any ordinary step). */
const MIN_LEAD_IN_MS = 30_000;

interface Call {
  readonly op: DriverOp;
  readonly target: string | null;
}

/** Whether a restarted process is killed again at its first kill point, and why. */
type Rekill = "forced" | "random" | null;

class Process {
  dead = false;
  current: Call | null = null;
  points = 0;
  /** Ticks that reached LinkedIn (at least one kill point) and resolved. Idle ticks do not count. */
  ticksDone = 0;
  killed: KillRecord | null = null;
  /** The suspension armed for the call now running, checked when it returns. */
  suspended: Suspension | null = null;
  /** A planned send sleep whose lead-in read is running or just returned: the next call, if it is that write, sleeps. */
  armedSleep: number | null = null;
  readonly touched = new Set<string>();
  readonly handle: DriverHandle;
  readonly engine: Engine;

  constructor(
    readonly opened: OpenedDb,
    readonly rekill: Rekill,
    /** Started right after a kill (not after a resume or at the very start). */
    readonly afterKill: boolean,
    make: (proc: Process) => { handle: DriverHandle; engine: Engine },
  ) {
    const made = make(this);
    this.handle = made.handle;
    this.engine = made.engine;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function scriptedTimeout(error: unknown): "before" | "after" | null {
  if (!(error instanceof Error)) return null;
  if (error.message.includes("scripted timeout after")) return "after";
  if (error.message.includes("scripted timeout before")) return "before";
  return null;
}

export interface RunOptions {
  readonly scenario: Scenario;
  readonly engine: EngineModule;
  readonly dbFile: string;
  readonly seed: number;
  readonly maxTicks?: number;
}

export async function runSimulation({ scenario, engine: module, dbFile, seed, maxTicks = DEFAULT_MAX_TICKS }: RunOptions): Promise<SimRun> {
  const startedWall = performance.now();
  const random = mulberry32(seed ^ 0x5eed_c0de);
  const seedFor = (): number => Math.floor(random() * 4_294_967_296);
  const clock = new VirtualClock(scenario.start);
  const world = new FakeWorld(scenario.world);
  const { facts, kills: plan } = scenario;

  const kills: KillRecord[] = [];
  const uncertainSends: UncertainSend[] = [];
  const userResumes: UserResume[] = [];
  const engineErrors: { at: Date; message: string }[] = [];
  const harnessFailures: string[] = [];
  const interventionRecords: InterventionRecord[] = [];
  const suspensions: Suspension[] = [];
  const sendCalls: SendCall[] = [];
  const processStarts: Date[] = [];
  /** Indexes into `scenario.interventions` that have fired. */
  const firedInterventions = new Set<number>();
  /** Changes an intervention scheduled for later, applied between ticks like the scenario's events. */
  const laterEvents: ScenarioEvent[] = [];
  /** Indexes into the suspension plan's slots already used. */
  const usedSlots = new Set<number>();
  /** Indexes into the suspension plan's send sleeps already used. */
  const usedSleeps = new Set<number>();
  /** Kills still to deliver in the burst under way, and the burst's restart delays. */
  let burst: { left: number; restartMs: readonly [number, number] } | null = null;
  /** World public ids whose last send result the engine could not know and has not looked at since. */
  const pendingReconcile = new Set<string>();
  /** Kills delivered during the current reconcile of each target. */
  const reconcileKills = new Map<string, number>();
  const pointCounts = new Map<string, number>();
  const forced = plan.forced ?? [];
  /** Indexes into `forced` already delivered. */
  const firedForced = new Set<number>();
  /** Scripted faults whose time has come, each waiting for the next call of its op on a member who is not scripted. */
  const armedFaults: ScheduledFault[] = [];
  let sessionBroken = false;
  let ticks = 0;
  let ticksWithWork = 0;

  const span = scenario.end.getTime() - scenario.start.getTime();
  const ensuring = (): boolean => plan.ensureAfter !== null && clock.now().getTime() - scenario.start.getTime() >= plan.ensureAfter * span;
  const slots = scenario.suspensions?.slots ?? [];
  const sleeps = scenario.suspensions?.sends ?? [];
  const quietSpans = [...slots, ...(scenario.quietSpans ?? [])];
  const inQuietSpan = (at: Date): boolean => quietSpans.some((span) => span.from <= at && at <= span.to);
  /** No random kill, fault or suspension: the run's quiet last day, inside a planned suspension slot or a quiet span. */
  const quiet = (): boolean => (scenario.quietFrom !== undefined && clock.now() >= scenario.quietFrom) || inQuietSpan(clock.now());
  const killed = (predicate: (kill: KillRecord) => boolean): boolean => kills.some(predicate);

  const publicIdOf = (memberId: string): string | null => memberByMemberId(facts, memberId)?.publicId ?? null;
  const scripted = (target: string | null): boolean => target !== null && facts.members.get(target)?.scripted === true;

  /** Takes the first not yet delivered forced kill that matches, if any. */
  function takeForced(matches: (kill: ForcedKill) => boolean): boolean {
    const index = forced.findIndex((kill, at) => !firedForced.has(at) && matches(kill));
    if (index === -1) return false;
    firedForced.add(index);
    return true;
  }

  /**
   * Hands an armed fault to the world right before a call that will take it: at the `before` kill
   * point, when no kill was decided there and the session is fine (the driver takes a fault after
   * that point and after the session check). Never for a call about a scripted member.
   */
  function injectFault(op: DriverOp, target: string | null): void {
    if (sessionBroken || scripted(target) || quiet()) return;
    const index = armedFaults.findIndex((fault) => fault.op === op);
    const [fault] = index === -1 ? [] : armedFaults.splice(index, 1);
    if (fault !== undefined) world.failNext(fault.op, fault.fault);
  }

  function instrument(driver: Driver, proc: Process): Driver {
    async function call<T>(op: DriverOp, target: string | null, run: () => Promise<T>): Promise<T> {
      proc.current = { op, target };
      if (target !== null) proc.touched.add(target);
      try {
        return await run();
      } catch (error) {
        const kind = SEND_OPS.get(op);
        const timeout = scriptedTimeout(error);
        if (kind !== undefined && target !== null && timeout !== null) {
          uncertainSends.push({ at: clock.now(), kind, publicId: target, effect: timeout === "after", via: `timeout ${timeout} effect` });
          pendingReconcile.add(target);
        }
        throw error;
      } finally {
        proc.current = null;
        const armed = proc.suspended;
        proc.suspended = null;
        if (armed !== null && !proc.dead && clock.now() < armed.landsAt) {
          harnessFailures.push(`${armed.startedAt.toISOString()}: a suspension of ${armed.op} for ${armed.target} did not land (the call returned at ${clock.now().toISOString()})`);
        }
      }
    }
    return {
      ensureSession: () => call("ensureSession", null, () => driver.ensureSession()),
      searchPeople: (query) => call("searchPeople", null, () => driver.searchPeople(query)),
      listRecommendations: () => call("listRecommendations", null, () => driver.listRecommendations()),
      viewProfile: (publicId) => call("viewProfile", publicId, () => driver.viewProfile(publicId)),
      listRecentConnections: () => call("listRecentConnections", null, () => driver.listRecentConnections()),
      listSentInvitations: () => call("listSentInvitations", null, () => driver.listSentInvitations()),
      readThread: (person) => call("readThread", publicIdOf(person.memberId) ?? person.publicId ?? null, () => driver.readThread(person)),
      sendInvite: (person, note, guard) => call("sendInvite", person.publicId, () => driver.sendInvite(person, note, guard)),
      sendMessage: (person, text, expected) => call("sendMessage", person.publicId, () => driver.sendMessage(person, text, expected)),
      withdrawInvite: (person, guard) => call("withdrawInvite", person.publicId, () => driver.withdrawInvite(person, guard)),
    };
  }

  /** Fires the scenario's interventions due at this call (see `Intervention`). */
  function intervene(op: DriverOp, target: string | null): void {
    if (target === null) return;
    (scenario.interventions ?? []).forEach((intervention, index) => {
      if (intervention.op !== op || intervention.target !== target) return;
      if (intervention.every !== true && firedInterventions.has(index)) return;
      if (intervention.when !== undefined && !intervention.when(context())) return;
      firedInterventions.add(index);
      const at = clock.now();
      interventionRecords.push({ label: intervention.label, target, at, phase: "fired", ...(intervention.tag === undefined ? {} : { tag: intervention.tag }) });
      intervention.apply({
        ...context(),
        later: (afterMs, label, apply) => {
          laterEvents.push({
            at: new Date(at.getTime() + afterMs),
            label,
            apply: (later) => {
              interventionRecords.push({ label, target, at: later.now, phase: "later" });
              apply(later);
            },
          });
        },
      });
    });
  }

  /** Whether a planned send sleep's step is still to do, from what LinkedIn shows now. */
  function sleepDue(sleep: SendSleep): boolean {
    const status = world.status(sleep.target);
    switch (sleep.op) {
      case "sendInvite":
        return status.degree !== 1 && status.pendingSince === null;
      case "withdrawInvite":
        return status.pendingSince !== null;
      case "sendMessage":
        return status.degree === 1;
      default: {
        const _exhaustive: never = sleep.op;
        return _exhaustive;
      }
    }
  }

  /**
   * When a write started now would begin `beforeEndMs` before a window's end: today's window if
   * that is still at least a step away, else the next working day's.
   */
  function sleepStart(now: Date, beforeEndMs: number): Date {
    const settings = facts.settings;
    for (let day = localDay(settings.timeZone, now), step = 0; step < 14; day = addDays(day, 1), step++) {
      if (!isWorkingDay(settings, day)) continue;
      const at = new Date(windowOn(settings, day).end.getTime() - beforeEndMs);
      if (at.getTime() - now.getTime() >= MIN_LEAD_IN_MS) return at;
    }
    throw new RangeError("no working day within two weeks");
  }

  function record(proc: Process, op: DriverOp, target: string, ms: number, cause: SuspensionCause): void {
    world.suspendNext(op, ms);
    const now = clock.now();
    const made: Suspension = { op, target, startedAt: now, landsAt: new Date(now.getTime() + ms), cause };
    suspensions.push(made);
    proc.suspended = made;
  }

  /** How long a random suspension starting now lasts: `lateMs` close to the window's end, else a draw in `otherMs`. */
  function randomLength(plan: SuspensionPlan): number {
    const now = clock.now();
    const end = windowOn(facts.settings, localDay(facts.settings.timeZone, now)).end;
    const late = end.getTime() - now.getTime() <= plan.lateWithinMs;
    return late ? plan.lateMs : Math.round(randomBetween(random, plan.otherMs[0], plan.otherMs[1]));
  }

  /**
   * Arms a suspension for the call now at its `before` kill point (the driver takes it in the step
   * right after):
   * - a write right after its planned lead-in read (`SendSleep`) sleeps for the plan's `ms`;
   * - the first read of a scripted member inside an unused planned slot is suspended for the slot's `ms`;
   * - else the lead-in read of an unused planned send sleep whose step is still to do is stretched
   *   so the write starts `startsBeforeEndMs` before the window's end;
   * - outside slots, quiet spans and the quiet day, a read or a write about anyone else at random.
   */
  function suspend(proc: Process, op: DriverOp, target: string | null): void {
    const plan = scenario.suspensions;
    const armed = proc.armedSleep;
    proc.armedSleep = null;
    if (plan === undefined || target === null) return;
    const now = clock.now();
    if (armed !== null) {
      const sleep = sleeps[armed];
      if (sleep !== undefined && sleep.op === op && sleep.target === target) {
        usedSleeps.add(armed);
        record(proc, op, target, sleep.ms, "send_sleep");
        return;
      }
    }
    if (scripted(target)) {
      if (!MEMBER_READS.has(op)) return;
      const slotIndex = slots.findIndex((slot, at) => !usedSlots.has(at) && slot.from <= now && now <= slot.to);
      const slot = slots[slotIndex];
      if (slot !== undefined) {
        usedSlots.add(slotIndex);
        record(proc, op, target, slot.ms, "slot");
        return;
      }
      const sleepIndex = sleeps.findIndex((sleep, at) => !usedSleeps.has(at) && sleep.target === target && LEAD_IN[sleep.op] === op && sleepDue(sleep));
      const sleep = sleeps[sleepIndex];
      if (sleep === undefined || !inWorkingWindow(facts.settings, now)) return;
      proc.armedSleep = sleepIndex;
      record(proc, op, target, sleepStart(now, sleep.startsBeforeEndMs).getTime() - now.getTime(), "lead_in");
      return;
    }
    if (quiet()) return;
    const chance = MEMBER_READS.has(op) ? plan.randomChance : isWriteOp(op) ? (plan.randomSendChance ?? 0) : 0;
    if (chance > 0 && random() < chance) record(proc, op, target, randomLength(plan), "random");
  }

  /** A real kill runs nothing more: the handle refuses every later step and the database is closed. */
  function die(proc: Process): void {
    proc.dead = true;
    proc.handle.revoke();
    if (proc.opened.sqlite.open) proc.opened.close();
  }

  function decideKill(proc: Process, point: KillPoint, target: string | null): KillRecord["cause"] | null {
    const key = `${point.op}/${point.phase}`;
    const nth = (pointCounts.get(key) ?? 0) + 1;
    pointCounts.set(key, nth);
    if (quiet()) return null;
    const shielded = scripted(target);
    const reconcileRead = target !== null && pendingReconcile.has(target) && RECONCILE_READS.has(point.op);
    // A rekill lands at the restarted process's first kill point, whenever that comes (idle ticks before it do not count).
    if (proc.points === 1 && proc.ticksDone === 0 && (proc.rekill === "forced" || (proc.rekill === "random" && !shielded))) return "rekill";
    const isForced = takeForced((kill) => {
      switch (kill.kind) {
        case "nth":
          return kill.op === point.op && kill.phase === point.phase && kill.nth === nth;
        case "member":
          return kill.op === point.op && kill.phase === point.phase && kill.target === target;
        case "reconcile_read":
          return reconcileRead && kill.target === target;
        case "between":
        case "rekill":
        case "burst":
          return false;
        default: {
          const _exhaustive: never = kill;
          return _exhaustive;
        }
      }
    });
    if (isForced) return "forced";
    // Random kills never land on a scripted member: its path must be reached in every seed.
    if (shielded) return null;
    const isSend = SEND_OPS.has(point.op);
    // At most two kills in a row on one reconcile: enough to prove a reconcile survives being cut short twice.
    const killedHere = reconcileRead ? (reconcileKills.get(target) ?? 0) : 0;
    if (reconcileRead && killedHere < 2 && random() < plan.reconcileRead) {
      reconcileKills.set(target, killedHere + 1);
      return "reconcile_read";
    }
    if (ensuring()) {
      if (reconcileRead && !killed((kill) => kill.duringReconcileRead)) return "ensure";
      if (isSend && target !== null && !killed((kill) => kill.phase === point.phase)) return "ensure";
    }
    const chance = isSend ? plan.sendPoint : plan.readPoint;
    return chance > 0 && random() < chance ? "random" : null;
  }

  function spawn(opened: OpenedDb, afterKill: boolean): Process {
    processStarts.push(clock.now());
    let rekill: Rekill = null;
    if (afterKill) {
      const lastTarget = kills.at(-1)?.target ?? null;
      const firstOnTarget = lastTarget !== null && kills.findIndex((kill) => kill.target === lastTarget) === kills.length - 1;
      if (firstOnTarget && takeForced((kill) => kill.kind === "rekill" && kill.target === lastTarget)) rekill = "forced";
      else if (random() < plan.quickRekill || (ensuring() && !killed((kill) => kill.beforeTickCompleted))) rekill = "random";
    }
    return new Process(opened, rekill, afterKill, (proc) => {
      const handle = world.connect({
        clock,
        random: mulberry32(seedFor()),
        hook: (point) => {
          if (proc.dead) return;
          proc.points += 1;
          const target = proc.current?.target ?? null;
          if (point.phase === "before" && target !== null && SEND_OPS.has(point.op)) sendCalls.push({ op: point.op, target, at: clock.now() });
          const cause = decideKill(proc, point, target);
          if (cause === null) {
            if (point.phase === "before") {
              injectFault(point.op, target);
              intervene(point.op, target);
              suspend(proc, point.op, target);
            }
            return;
          }
          const record: KillRecord = {
            at: clock.now(),
            op: point.op,
            phase: point.phase,
            cause,
            target,
            beforeTickCompleted: proc.afterKill && proc.ticksDone === 0,
            duringReconcileRead: target !== null && pendingReconcile.has(target) && RECONCILE_READS.has(point.op),
            verified: "pending",
          };
          kills.push(record);
          proc.killed = record;
          const kind = SEND_OPS.get(point.op);
          if (kind !== undefined && target !== null) {
            uncertainSends.push({ at: clock.now(), kind, publicId: target, effect: point.phase === "after", via: `kill at ${point.phase}` });
            pendingReconcile.add(target);
          }
          die(proc);
          throw new SimKill(point);
        },
      });
      const engine = module.createEngine({
        db: opened.db,
        driver: instrument(handle.driver, proc),
        clock,
        random: mulberry32(seedFor()),
      });
      return { handle, engine };
    });
  }

  async function restart(delayMs: readonly [number, number] = RESTART_MS): Promise<Process> {
    await clock.sleep(delayMs[0] + Math.floor(random() * (delayMs[1] - delayMs[0])));
    return spawn(openDb(dbFile, { durable: false }), true);
  }

  /**
   * The restart delay of a burst kill due after this resolved tick, or null: the next kill of a
   * burst under way, or the first of a burst whose threshold the current run of pieces of work has reached.
   */
  function burstDue(): readonly [number, number] | null {
    if (burst !== null && burst.left > 0) {
      burst.left -= 1;
      return burst.restartMs;
    }
    if (burst !== null || quiet()) return null;
    const planned = forced.find((kill) => kill.kind === "burst");
    if (planned === undefined || planned.kind !== "burst") return null;
    const run = currentRun(world.log, facts.settings.breaks.minutesMin * 60_000, clock.now());
    if (run < planned.runAtLeast) return null;
    takeForced((kill) => kill === planned);
    burst = { left: planned.count - 1, restartMs: planned.restartMs };
    return planned.restartMs;
  }

  async function killBetween(proc: Process, cause: KillRecord["cause"]): Promise<void> {
    const record: KillRecord = {
      at: clock.now(),
      op: null,
      phase: "between",
      cause,
      target: null,
      beforeTickCompleted: proc.afterKill && proc.ticksDone === 0,
      duringReconcileRead: false,
      verified: "pending",
    };
    kills.push(record);
    die(proc);
    try {
      await proc.handle.driver.ensureSession();
      record.verified = "not_revoked";
      harnessFailures.push(`${record.at.toISOString()}: a revoked driver handle still answered`);
    } catch (error) {
      record.verified = error instanceof HandleRevoked ? "revoked" : "not_revoked";
      if (record.verified === "not_revoked") harnessFailures.push(`${record.at.toISOString()}: revoked handle threw ${describe(error)}`);
    }
    if (proc.opened.sqlite.open) harnessFailures.push(`${record.at.toISOString()}: the database was still open after a kill`);
  }

  // ---- setup
  let proc = spawn(openDb(dbFile, { durable: false }), false);
  scenario.setup({ db: proc.opened.db, world, now: clock.now(), facts });

  const events = [...scenario.events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const faults = [...scenario.faults].sort((a, b) => a.at.getTime() - b.at.getTime());
  const downtimes = [...scenario.downtimes].sort((a, b) => a.from.getTime() - b.from.getTime());
  const breaks = [...scenario.sessionBreaks].sort((a, b) => a.at.getTime() - b.at.getTime());
  let eventIndex = 0;
  let faultIndex = 0;
  let downtimeIndex = 0;
  let breakIndex = 0;
  /** Stops the user has seen, by id, with when he will press Resume. */
  const resumeAt = new Map<number, Date>();
  const fixBy: Date[] = [];

  const context = (): SimContext => ({ db: proc.opened.db, world, now: clock.now(), facts });

  function observeStops(): void {
    const active = proc.opened.db.select().from(safetyStops).where(isNull(safetyStops.resumedAt)).all();
    for (const stop of active) {
      if (resumeAt.has(stop.id)) continue;
      const [min, max] = scenario.userResumeHours;
      resumeAt.set(stop.id, new Date(clock.now().getTime() + randomBetween(random, min, max) * 3_600_000));
    }
  }

  /** The user logs in again in the window and presses Resume; the app connects a fresh handle (the old one is latched). */
  function resumeByUser(now: Date): void {
    world.fixSession();
    sessionBroken = false;
    const db = proc.opened.db;
    const active = db.select().from(safetyStops).where(isNull(safetyStops.resumedAt)).all();
    const resumed = active.length === 0 ? null : module.resumeSafetyStop(db, now);
    userResumes.push({ at: now, stopIds: active.map((stop) => stop.id), reasons: active.map((stop) => stop.reason), resumed });
    // One press of Resume lifts whatever is active; a stop raised later is noticed afresh.
    resumeAt.clear();
    const old = proc;
    old.handle.revoke();
    proc = spawn(old.opened, false);
  }

  while (clock.now() < scenario.end) {
    if (ticks >= maxTicks) {
      harnessFailures.push(`stopped after ${maxTicks} ticks at ${clock.now().toISOString()}: the engine never let time pass`);
      break;
    }
    const now = clock.now();

    const downtime = downtimes[downtimeIndex];
    if (downtime !== undefined && downtime.from <= now) {
      downtimeIndex += 1;
      if (!proc.dead) await killBetween(proc, "downtime");
      clock.advanceTo(downtime.to);
      proc = await restart();
      continue;
    }

    for (let event = events[eventIndex]; event !== undefined && event.at <= now; event = events[eventIndex]) {
      event.apply(context());
      eventIndex += 1;
    }
    laterEvents.sort((a, b) => a.at.getTime() - b.at.getTime());
    while (laterEvents[0] !== undefined && laterEvents[0].at <= now) laterEvents.shift()?.apply(context());
    for (let fault = faults[faultIndex]; fault !== undefined && fault.at <= now; fault = faults[faultIndex]) {
      armedFaults.push(fault);
      faultIndex += 1;
    }
    for (let broken = breaks[breakIndex]; broken !== undefined && broken.at <= now; broken = breaks[breakIndex]) {
      world.breakSession(broken.kind);
      sessionBroken = true;
      fixBy.push(broken.userFixesBy);
      breakIndex += 1;
    }

    const dueStops = [...resumeAt].filter(([, at]) => at <= now).map(([id]) => id);
    const fixDue = sessionBroken && fixBy.some((at) => at <= now);
    if (dueStops.length > 0 || fixDue) {
      if (fixDue) fixBy.splice(0, fixBy.length);
      resumeByUser(now);
    }

    let result: TickResult;
    const pointsBefore = proc.points;
    try {
      result = await proc.engine.tick();
      ticks += 1;
    } catch (error) {
      ticks += 1;
      if (proc.killed !== null) {
        proc.killed.verified = "rejected";
      } else {
        engineErrors.push({ at: clock.now(), message: describe(error) });
        die(proc);
      }
      proc = await restart();
      continue;
    }
    if (proc.killed !== null) {
      proc.killed.verified = "swallowed";
      harnessFailures.push(
        `${proc.killed.at.toISOString()}: the engine swallowed a kill at ${proc.killed.op ?? "?"}/${proc.killed.phase}; the tick resolved`,
      );
      proc = await restart();
      continue;
    }
    if (result.did !== null) ticksWithWork += 1;
    if (proc.points > pointsBefore) proc.ticksDone += 1;
    for (const target of proc.touched) {
      pendingReconcile.delete(target);
      reconcileKills.delete(target);
    }
    proc.touched.clear();
    observeStops();

    const burstRestart = burstDue();
    if (burstRestart !== null) {
      await killBetween(proc, "burst");
      proc = await restart(burstRestart);
      continue;
    }
    const forcedBetween = !quiet() && takeForced((kill) => kill.kind === "between" && kill.nth === ticks);
    const ensureBetween = ensuring() && !killed((kill) => kill.phase === "between" && kill.cause !== "downtime");
    if (forcedBetween || (!quiet() && (ensureBetween || (plan.betweenTicks > 0 && random() < plan.betweenTicks)))) {
      await killBetween(proc, forcedBetween ? "forced" : ensureBetween ? "ensure" : "random");
      proc = await restart();
      continue;
    }

    const wake = result.wakeAt instanceof Date && Number.isFinite(result.wakeAt.getTime()) ? result.wakeAt.getTime() : Number.NaN;
    if (Number.isNaN(wake)) harnessFailures.push(`${clock.now().toISOString()}: tick returned an invalid wakeAt`);
    const after = clock.now().getTime();
    const candidates = [
      Number.isNaN(wake) ? after + scenario.pollMs : Math.max(wake, after + 1),
      after + scenario.pollMs,
      events[eventIndex]?.at.getTime(),
      ...laterEvents.map((event) => event.at.getTime()),
      faults[faultIndex]?.at.getTime(),
      downtimes[downtimeIndex]?.from.getTime(),
      breaks[breakIndex]?.at.getTime(),
      ...[...resumeAt.values()].map((at) => at.getTime()),
      ...(sessionBroken ? fixBy.map((at) => at.getTime()) : []),
    ].filter((at): at is number => at !== undefined);
    clock.advanceTo(new Date(Math.max(after + 1, Math.min(...candidates))));
  }

  for (const kill of kills) {
    if (kill.verified === "pending") harnessFailures.push(`${kill.at.toISOString()}: a kill at ${kill.op ?? "between"}/${kill.phase} was never seen to land`);
  }
  if (!proc.dead) die(proc);

  return {
    seed,
    scenario,
    world,
    dbFile,
    kills,
    uncertainSends,
    userResumes,
    engineErrors,
    harnessFailures,
    interventions: interventionRecords,
    suspensions,
    sendCalls,
    processStarts,
    ticks,
    ticksWithWork,
    finishedAt: clock.now(),
    wallMs: performance.now() - startedWall,
  };
}
