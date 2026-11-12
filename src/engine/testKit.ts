/**
 * Test helpers for the engine's tests: a real SQLite database in a temp directory, the fake
 * LinkedIn, a virtual clock and a few seeding functions. Not used by the app.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { setSettings, type SettingsPatch } from "../config/settings";
import { openDb, type OpenedDb } from "../db/index";
import { actions, campaigns, eventLog, people, prospects, type CampaignStatus, type ProspectStage } from "../db/schema";
import { FakeWorld, type KillHook, type MemberSpec, type WorldOptions } from "../linkedin/fake/world";
import type { Clock, Driver, Engine, RandomSource } from "./ports";
import { createEngine } from "./engine";

/** Monday 16 November 2026, 10:00 in Europe/Rome (CET, UTC+1): inside the default working window. */
export const START = new Date("2026-11-16T09:00:00Z");
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

export interface VirtualClock extends Clock {
  set(at: Date): void;
  advance(ms: number): void;
}

export function virtualClock(start: Date = START): VirtualClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
    set: (at) => {
      t = at.getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/** A small deterministic generator (mulberry32), so runs repeat exactly. */
export function seededRandom(seed = 1): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface KitOptions {
  readonly hook?: KillHook;
  readonly random?: RandomSource;
  readonly world?: Partial<WorldOptions>;
  /** Replaces driver operations, for results the fake cannot be scripted to give. */
  readonly wrap?: (driver: Driver) => Driver;
}

export interface Kit {
  /** The current connection; `restart` opens a new one on the same file. */
  readonly opened: OpenedDb;
  readonly db: OpenedDb["db"];
  readonly clock: VirtualClock;
  readonly world: FakeWorld;
  readonly random: RandomSource;
  engine: Engine;
  /** A new engine (a new process) on the same connection and world, with a new driver handle. */
  newEngine(options?: Pick<KitOptions, "hook" | "wrap">): Engine;
  /** Closes the database as a killed process would: every later write of the old engine throws. */
  crash(): void;
  /** Opens the database file again and starts a new engine on it, as a restarted process. */
  restart(options?: Pick<KitOptions, "hook" | "wrap">): Engine;
  settings(patch: SettingsPatch): void;
  close(): void;
}

export function createKit(options: KitOptions = {}): Kit {
  const dir = mkdtempSync(join(tmpdir(), "lo-engine-"));
  const file = join(dir, "app.db");
  let opened = openDb(file, { durable: false });
  const clock = virtualClock();
  const world = new FakeWorld({ start: new Date(START.getTime() - 60 * 24 * HOUR), ...options.world });
  const random = options.random ?? seededRandom(7);
  const newEngine = (o: Pick<KitOptions, "hook" | "wrap"> = {}): Engine => {
    const handle = world.connect({ clock, random, ...(o.hook === undefined ? {} : { hook: o.hook }) });
    const driver = o.wrap === undefined ? handle.driver : o.wrap(handle.driver);
    return createEngine({ db: opened.db, driver, clock, random });
  };
  const kit: Kit = {
    get opened() {
      return opened;
    },
    get db() {
      return opened.db;
    },
    clock,
    world,
    random,
    newEngine,
    engine: newEngine({ ...(options.hook === undefined ? {} : { hook: options.hook }), ...(options.wrap === undefined ? {} : { wrap: options.wrap }) }),
    crash: () => {
      opened.close();
    },
    restart: (o = {}) => {
      if (opened.sqlite.open) opened.close();
      opened = openDb(file, { durable: false });
      kit.engine = newEngine(o);
      return kit.engine;
    },
    settings: (patch) => {
      setSettings(opened.db, patch, clock.now());
    },
    close: () => {
      try {
        if (opened.sqlite.open) opened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
  return kit;
}

export const TEMPLATES = {
  firstMessage: "Hi {{first_name}}, thanks for connecting.",
  followUp: "Hi {{first_name}}, following up on my last note.",
} as const;

export function addCampaign(
  kit: Pick<Kit, "db" | "clock">,
  values: Partial<typeof campaigns.$inferInsert> & { status?: CampaignStatus } = {},
): number {
  const now = kit.clock.now();
  return kit.db
    .insert(campaigns)
    .values({
      name: "Test campaign",
      status: "running",
      discoverySource: "recommendations",
      firstMessage: TEMPLATES.firstMessage,
      followUp: TEMPLATES.followUp,
      createdAt: now,
      updatedAt: now,
      ...values,
    })
    .returning({ id: campaigns.id })
    .get().id;
}

let memberSeq = 0;

/** A member in the fake world and a matching person row. Returns the person id and the member spec. */
export function addPerson(
  kit: Pick<Kit, "db" | "clock" | "world">,
  spec: Partial<MemberSpec> = {},
  row: Partial<typeof people.$inferInsert> = {},
): { personId: number; spec: MemberSpec } {
  memberSeq += 1;
  const n = memberSeq;
  const member: MemberSpec = {
    publicId: `test-person-${n}`,
    memberId: `ACoATestPerson${n}`,
    fullName: `Test Person ${n}`,
    degree: 2,
    ...spec,
  };
  kit.world.addMember(member);
  const personId = kit.db
    .insert(people)
    .values({
      publicId: member.publicId,
      profileUrl: `https://www.linkedin.com/in/${member.publicId}/`,
      fullName: member.fullName,
      firstName: member.fullName.split(" ")[0] ?? null,
      firstSeenAt: kit.clock.now(),
      ...row,
    })
    .returning({ id: people.id })
    .get().id;
  return { personId, spec: member };
}

export function addProspect(
  kit: Pick<Kit, "db" | "clock">,
  campaignId: number,
  personId: number,
  values: Partial<typeof prospects.$inferInsert> & { stage?: ProspectStage } = {},
): number {
  return kit.db
    .insert(prospects)
    .values({ campaignId, personId, stage: "approved", foundAt: kit.clock.now(), approvedAt: kit.clock.now(), ...values })
    .returning({ id: prospects.id })
    .get().id;
}

export function prospect(kit: Pick<Kit, "db">, id: number) {
  const row = kit.db.select().from(prospects).where(eq(prospects.id, id)).get();
  if (row === undefined) throw new Error(`no prospect ${id}`);
  return row;
}

export function person(kit: Pick<Kit, "db">, id: number) {
  const row = kit.db.select().from(people).where(eq(people.id, id)).get();
  if (row === undefined) throw new Error(`no person ${id}`);
  return row;
}

export function actionByKey(kit: Pick<Kit, "db">, key: string) {
  return kit.db.select().from(actions).where(eq(actions.idempotencyKey, key)).get();
}

export function actionRows(kit: Pick<Kit, "db">) {
  return kit.db.select().from(actions).all();
}

export function events(kit: Pick<Kit, "db">): string[] {
  return kit.db
    .select({ message: eventLog.message })
    .from(eventLog)
    .all()
    .map((row) => row.message);
}

/** Runs one tick, then moves the clock to its `wakeAt`. */
export async function step(kit: Pick<Kit, "clock" | "engine">) {
  const result = await kit.engine.tick();
  kit.clock.set(result.wakeAt);
  return result;
}

/** Runs ticks until one did something (or `max` ticks), moving the clock to each wakeAt. */
export async function nextDid(kit: Pick<Kit, "clock" | "engine">, max = 50) {
  for (let i = 0; i < max; i++) {
    const result = await step(kit);
    if (result.did !== null) return result;
  }
  throw new Error(`nothing done in ${max} ticks`);
}

// ---------------------------------------------------------------- seeding

export type CampaignValues = NonNullable<Parameters<typeof addCampaign>[1]>;
export type ProspectValues = NonNullable<Parameters<typeof addProspect>[3]>;

/** A running campaign that waits no time between steps, unless told otherwise. */
export function seedCampaign(kit: Kit, values: CampaignValues = {}) {
  return addCampaign(kit, {
    acceptToMessageMinHours: 0,
    acceptToMessageMaxHours: 0,
    followUpDelayMinHours: 0,
    followUpDelayMaxHours: 0,
    ...values,
  });
}

export function seedApproved(kit: Kit, campaignId: number, spec: Partial<MemberSpec> = {}, row: Partial<typeof people.$inferInsert> = {}) {
  const added = addPerson(kit, spec, row);
  const prospectId = addProspect(kit, campaignId, added.personId, { stage: "approved" });
  return { ...added, prospectId };
}

/** A prospect whose invite was accepted: a connection with an empty conversation, due for the first message. */
export function seedAccepted(kit: Kit, campaignId: number, spec: Partial<MemberSpec> = {}, values: ProspectValues = {}) {
  const added = addPerson(kit, { degree: 1, connectedAt: new Date(START.getTime() - HOUR), ...spec });
  kit.db.update(people).set({ memberId: added.spec.memberId }).where(eq(people.id, added.personId)).run();
  const prospectId = addProspect(kit, campaignId, added.personId, {
    stage: "accepted",
    invitedAt: new Date(START.getTime() - 48 * HOUR),
    acceptanceObservedAt: new Date(START.getTime() - HOUR),
    nextActionAt: START,
    ...values,
  });
  kit.db
    .update(people)
    .set({ contactedAt: new Date(START.getTime() - 48 * HOUR), contactedProspectId: prospectId })
    .where(eq(people.id, added.personId))
    .run();
  return { ...added, prospectId };
}

/** An invite sent by the app `days` ago, still pending. */
export function seedInvited(kit: Kit, campaignId: number, days: number, spec: Partial<MemberSpec> = {}) {
  const sentAt = new Date(START.getTime() - days * 24 * HOUR);
  const added = addPerson(kit, { invitedOutsideApp: true, invitedAt: sentAt, ...spec });
  kit.db.update(people).set({ memberId: added.spec.memberId }).where(eq(people.id, added.personId)).run();
  const prospectId = addProspect(kit, campaignId, added.personId, { stage: "invited", invitedAt: sentAt });
  kit.db.update(people).set({ contactedAt: sentAt, contactedProspectId: prospectId }).where(eq(people.id, added.personId)).run();
  return { ...added, prospectId };
}

/** Keeps the connections check from being due for the next two hours (it ran an hour ago). */
export function seedConnectionsChecked(kit: Kit) {
  const at = new Date(kit.clock.now().getTime() - HOUR);
  kit.db
    .insert(actions)
    .values({ type: "connections_check", status: "done", idempotencyKey: `connections_check:seed:${at.getTime()}`, attempts: 1, startedAt: at, finishedAt: at })
    .run();
}

export async function runUntil(kit: Kit, done: () => boolean, max = 60) {
  for (let i = 0; i < max; i++) {
    if (done()) return;
    await step(kit);
  }
  if (!done()) throw new Error(`condition not reached in ${max} ticks`);
}

