/**
 * The fake driver: a `Driver` handle over a simulated LinkedIn (`FakeWorld`). This file holds what
 * belongs to one handle, which models one running process: simulated time per operation, kill
 * points, revocation, scripted faults and the safety-stop latch. What LinkedIn shows and does is
 * the world's (`world.ts`).
 *
 * Every operation runs the same steps: refuse if revoked or latched, call the hook with `before`,
 * sleep a random 2–20 s on the injected clock (or the time `suspendNext` set for this call), settle
 * the world, check the session, take a scripted
 * fault, act, call the hook with `after`. A revoked handle throws at its next step and does nothing
 * more, so a killed process never does what it had not yet done.
 */
import type { Driver, InviteResult, MessageResult, PersonRef, ReadThreadResult, SearchQuery, WithdrawResult } from "../driver";
import { LinkedInError, SearchCapped, Unexpected } from "../errors";
import type { ConnectionCard } from "../parse/connections";
import type { Profile } from "../parse/profile";
import type { RecommendationsResult } from "../parse/recommendations";
import type { SearchResults } from "../parse/search";
import type { SentInvitationCard } from "../parse/sentInvitations";
import type { PageClassification } from "../session";
import type { Clock, RandomSource } from "../../engine/ports";

export type DriverOp = keyof Driver;

/**
 * A scripted fault for the next call of one operation:
 * - `unexpected`: throws `Unexpected`; nothing happens.
 * - `timeout_before_effect`: throws a plain `Error`; nothing happens.
 * - `timeout_after_effect`: the effect happens and is logged, then a plain `Error` is thrown.
 * - `search_capped`: throws `SearchCapped`; nothing happens.
 */
export type FaultKind = "unexpected" | "timeout_before_effect" | "timeout_after_effect" | "search_capped";

/**
 * Where a call can be killed: `before` nothing has happened; `typed` (only `sendMessage`) the text
 * is in the message box, not sent; `after` the effect has happened and is logged, the call has not
 * returned.
 */
export type KillPhase = "before" | "typed" | "after";

export interface KillPoint {
  readonly op: DriverOp;
  readonly phase: KillPhase;
}

/** Called at each kill point. A throw propagates unchanged and the call does nothing more. */
export type KillHook = (point: KillPoint) => void | Promise<void>;

export interface ConnectOptions {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly hook?: KillHook;
}

export interface DriverHandle {
  readonly driver: Driver;
  /** Kills the handle: every later step of every call on it throws `HandleRevoked` and has no effect. */
  revoke(): void;
}

/** Thrown by a call on a revoked handle. */
export class HandleRevoked extends Error {
  constructor(op: DriverOp) {
    super(`fake driver: ${op} on a revoked handle`);
    this.name = "HandleRevoked";
  }
}

/**
 * What the handle needs from the world. Each method acts at `now` and logs what LinkedIn received
 * or showed. The world implements it privately, so only a handle can change the world.
 */
export interface FakeLinkedIn {
  /** Makes everything scripted to happen up to `now` visible. */
  settle(now: Date): void;
  /** The typed error the session shows (the page load is logged), or null when it is ok. */
  sessionError(op: DriverOp, now: Date): LinkedInError | null;
  takeFault(op: DriverOp): FaultKind | undefined;
  /** How long the next call of `op` takes before its effect, when `suspendNext` set one. */
  takeSuspension(op: DriverOp): number | undefined;
  ensureSession(now: Date): PageClassification;
  searchPeople(query: SearchQuery, now: Date): SearchResults;
  listRecommendations(now: Date): RecommendationsResult;
  viewProfile(publicId: string, now: Date): Profile;
  listRecentConnections(now: Date): ConnectionCard[];
  listSentInvitations(now: Date): SentInvitationCard[];
  readThread(person: { readonly memberId: string; readonly publicId?: string }, now: Date): ReadThreadResult;
  sendInvite(person: PersonRef, note: string | null, now: Date): InviteResult;
  /** Opens the message box, clears any draft and types `text`. Nothing is sent. */
  typeMessage(person: PersonRef, text: string, now: Date): void;
  /**
   * Sends what is in the message box, unless the conversation no longer shows `expectedCount`
   * messages: then the box is cleared, nothing is sent and the result is `thread_changed`.
   */
  sendTyped(person: PersonRef, expectedCount: number, now: Date): MessageResult;
  withdrawInvite(person: PersonRef, now: Date): WithdrawResult;
}

const SAFETY_STOPS: ReadonlySet<LinkedInError["kind"]> = new Set(["logged_out", "checkpoint", "restricted", "limit_hit"]);
const MIN_STEP_MS = 2_000;
const MAX_STEP_MS = 20_000;

export function createFakeDriver(world: FakeLinkedIn, { clock, random, hook }: ConnectOptions): DriverHandle {
  let revoked = false;
  let stopped: LinkedInError | undefined;

  function alive(op: DriverOp): void {
    if (revoked) throw new HandleRevoked(op);
  }

  async function point(op: DriverOp, phase: KillPhase): Promise<void> {
    if (hook !== undefined) await hook({ op, phase });
    alive(op);
  }

  async function run<T>(op: DriverOp, act: () => T | Promise<T>): Promise<T> {
    alive(op);
    if (stopped !== undefined) throw stopped;
    world.settle(clock.now());
    await point(op, "before");
    await clock.sleep(world.takeSuspension(op) ?? MIN_STEP_MS + Math.floor(random() * (MAX_STEP_MS - MIN_STEP_MS + 1)));
    alive(op);
    const now = clock.now();
    world.settle(now);
    try {
      const sessionError = world.sessionError(op, now);
      if (sessionError !== null) throw sessionError;
    } catch (error) {
      latch(error);
      throw error;
    }
    const fault = world.takeFault(op);
    if (fault === "unexpected") throw new Unexpected(`fake driver: scripted unexpected page on ${op}`);
    if (fault === "timeout_before_effect") throw new Error(`fake driver: scripted timeout before ${op} took effect`);
    if (fault === "search_capped") throw new SearchCapped(`fake driver: scripted search cap on ${op}`);
    let result: T;
    try {
      result = await act();
    } catch (error) {
      latch(error);
      throw error;
    }
    await point(op, "after");
    if (fault === "timeout_after_effect") throw new Error(`fake driver: scripted timeout after ${op} took effect`);
    return result;
  }

  function latch(error: unknown): void {
    if (error instanceof LinkedInError && SAFETY_STOPS.has(error.kind)) stopped = error;
  }

  const driver: Driver = {
    ensureSession: () => run("ensureSession", () => world.ensureSession(clock.now())),
    searchPeople: (query) => run("searchPeople", () => world.searchPeople(query, clock.now())),
    listRecommendations: () => run("listRecommendations", () => world.listRecommendations(clock.now())),
    viewProfile: (publicId) => run("viewProfile", () => world.viewProfile(publicId, clock.now())),
    listRecentConnections: () => run("listRecentConnections", () => world.listRecentConnections(clock.now())),
    listSentInvitations: () => run("listSentInvitations", () => world.listSentInvitations(clock.now())),
    readThread: (person) => run("readThread", () => world.readThread(person, clock.now())),
    sendInvite: (person, note) => run("sendInvite", () => world.sendInvite(person, note, clock.now())),
    sendMessage: (person, text, expected) =>
      run("sendMessage", async () => {
        world.typeMessage(person, text, clock.now());
        await point("sendMessage", "typed");
        world.settle(clock.now());
        return world.sendTyped(person, expected.messageCount, clock.now());
      }),
    withdrawInvite: (person) => run("withdrawInvite", () => world.withdrawInvite(person, clock.now())),
  };

  return {
    driver,
    revoke() {
      revoked = true;
    },
  };
}
