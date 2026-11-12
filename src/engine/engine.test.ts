import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { actions, campaigns, prospects, safetyStops } from "../db/schema";
import { getSettings } from "../config/settings";
import { pickDueWork } from "./engine";
import { raiseSafetyStop } from "./safetyStop";
import {
  actionByKey,
  actionRows,
  addCampaign,
  addPerson,
  addProspect,
  createKit,
  HOUR,
  MINUTE,
  prospect,
  seedAccepted,
  seedApproved,
  seedCampaign,
  seedConnectionsChecked,
  seedInvited,
  seededRandom,
  START,
  step,
  type Kit,
} from "./testKit";

let kit: Kit;
beforeEach(() => {
  kit = createKit();
});
afterEach(() => kit.close());

/** An approved prospect ready to invite: the person's member id is not known yet (the profile view supplies it). */
function approved(campaignId: number, spec = {}) {
  const added = addPerson(kit, spec);
  const prospectId = addProspect(kit, campaignId, added.personId, { stage: "approved" });
  return { ...added, prospectId };
}

describe("tick: before any work", () => {
  it("with nothing due does nothing and wakes a minute later", async () => {
    const result = await kit.engine.tick();
    expect(result).toEqual({ did: null, wakeAt: new Date(START.getTime() + MINUTE) });
    expect(actionRows(kit)).toHaveLength(0);
  });

  it("closes rows left in progress before anything else: a step becomes unknown, a read fails as interrupted", async () => {
    kit.db.insert(actions).values({ type: "message", status: "in_progress", idempotencyKey: "message1:99", attempts: 1, startedAt: START }).run();
    kit.db.insert(actions).values({ type: "thread_check", status: "in_progress", idempotencyKey: "thread_check:1", attempts: 1, startedAt: START }).run();
    raiseSafetyStop(kit.db, { reason: "logged_out" }, START);
    kit.clock.advance(MINUTE);
    await kit.engine.tick();
    expect(actionByKey(kit, "message1:99")?.status).toBe("unknown");
    expect(actionByKey(kit, "thread_check:1")).toMatchObject({ status: "failed", errorKind: "interrupted", finishedAt: kit.clock.now() });
  });

  it("does nothing while a safety stop is active, and wakes a minute later", async () => {
    const campaignId = addCampaign(kit);
    approved(campaignId);
    raiseSafetyStop(kit.db, { reason: "checkpoint" }, START);
    expect(await kit.engine.tick()).toEqual({ did: null, wakeAt: new Date(START.getTime() + MINUTE) });
    expect(kit.world.log).toHaveLength(0);
  });

  it("does nothing outside the working window and wakes at the start of the next one", async () => {
    const campaignId = addCampaign(kit);
    approved(campaignId);
    kit.clock.set(new Date("2026-11-16T17:30:00Z")); // Monday 18:30 in Rome
    expect(await kit.engine.tick()).toEqual({ did: null, wakeAt: new Date("2026-11-17T08:00:00Z") });
    kit.clock.set(new Date("2026-11-21T10:00:00Z")); // Saturday
    expect(await kit.engine.tick()).toEqual({ did: null, wakeAt: new Date("2026-11-23T08:00:00Z") });
    expect(kit.world.log).toHaveLength(0);
  });

  it("does nothing in the last 5 minutes of the window", async () => {
    const campaignId = addCampaign(kit);
    approved(campaignId);
    kit.clock.set(new Date("2026-11-16T16:55:00Z")); // Monday 17:55 in Rome
    expect(await kit.engine.tick()).toEqual({ did: null, wakeAt: new Date("2026-11-17T08:00:00Z") });
    kit.clock.set(new Date("2026-11-16T16:54:59Z"));
    expect((await kit.engine.tick()).did).not.toBeNull();
  });

  it("reads settings every tick, so a changed working window applies at once", async () => {
    const campaignId = addCampaign(kit);
    approved(campaignId);
    kit.settings({ workingHours: { start: "11:00", end: "18:00" } });
    expect(await kit.engine.tick()).toEqual({ did: null, wakeAt: new Date("2026-11-16T10:00:00Z") });
  });
});

describe("pacing", () => {
  it("waits a random gap after an action, and wakeAt is that gate", async () => {
    kit.settings({ actionGapSeconds: { min: 100, max: 100 } });
    const campaignId = addCampaign(kit);
    approved(campaignId);
    approved(campaignId);
    const first = await kit.engine.tick();
    expect(first.did).not.toBeNull();
    const afterAction = kit.clock.now();
    expect(first.wakeAt).toEqual(new Date(afterAction.getTime() + 100_000));
    // Too early: nothing happens, wake at the gate.
    expect(await kit.engine.tick()).toEqual({ did: null, wakeAt: first.wakeAt });
    kit.clock.set(first.wakeAt);
    expect((await kit.engine.tick()).did).not.toBeNull();
  });

  it("takes a break after every N actions", async () => {
    kit.settings({
      actionGapSeconds: { min: 60, max: 60 },
      breaks: { everyActionsMin: 2, everyActionsMax: 2, minutesMin: 20, minutesMax: 20 },
    });
    const campaignId = addCampaign(kit);
    for (let i = 0; i < 4; i++) approved(campaignId);
    const pauses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await kit.engine.tick();
      expect(result.did).not.toBeNull();
      pauses.push(result.wakeAt.getTime() - kit.clock.now().getTime());
      kit.clock.set(result.wakeAt);
    }
    expect(pauses).toEqual([60_000, 20 * MINUTE, 60_000, 20 * MINUTE]);
  });

  it("a new engine after a restart does not act before the newest ledger time plus a gap", async () => {
    kit.settings({ actionGapSeconds: { min: 120, max: 120 } });
    const campaignId = addCampaign(kit);
    approved(campaignId);
    approved(campaignId);
    await kit.engine.tick();
    const last = Math.max(...actionRows(kit).map((row) => row.finishedAt?.getTime() ?? 0));
    kit.engine = kit.newEngine();
    const result = await kit.engine.tick();
    expect(result).toEqual({ did: null, wakeAt: new Date(last + 120_000) });
  });

  it.each([
    ["a read", "profile_view", "profile_view:1"],
    ["a step", "invite", "invite:99"],
  ] as const)("a new engine that finds %s left in progress waits one gap from its first tick, not from the row's start", async (_label, type, key) => {
    kit.settings({ actionGapSeconds: { min: 120, max: 120 } });
    const campaignId = addCampaign(kit);
    approved(campaignId);
    // The killed run claimed the row 10 s ago; LinkedIn may have loaded the page any time since.
    kit.db.insert(actions).values({ type, status: "in_progress", idempotencyKey: key, attempts: 1, startedAt: new Date(START.getTime() - 10_000) }).run();
    const result = await kit.engine.tick();
    expect(result).toEqual({ did: null, wakeAt: new Date(START.getTime() + 120_000) });
  });

  it("the gate set on the first tick holds even when that tick stops early, e.g. for a safety stop", async () => {
    kit.settings({ actionGapSeconds: { min: 120, max: 120 } });
    const campaignId = addCampaign(kit);
    approved(campaignId);
    kit.db.insert(actions).values({ type: "message", status: "in_progress", idempotencyKey: "message1:99", attempts: 1, startedAt: new Date(START.getTime() - 10_000) }).run();
    raiseSafetyStop(kit.db, { reason: "logged_out" }, START);
    expect((await kit.engine.tick()).did).toBeNull();
    kit.db.update(safetyStops).set({ resumedAt: START }).run();
    kit.clock.set(new Date(START.getTime() + 60_000));
    expect(await kit.engine.tick()).toEqual({ did: null, wakeAt: new Date(START.getTime() + 120_000) });
  });

  // Seed 37 is one where gating from the interrupted row's start let the next page load come too soon.
  it.each(
    (["viewProfile", "sendInvite"] as const).flatMap((op) => [1, 2, 3, 4, 5, 6, 7, 8, 37].map((seed) => [op, seed] as const)),
  )(
    "after a kill in %s, the next page load is never sooner than actionGapSeconds.min after the restart (seed %i)",
    async (op, seed) => {
      kit.close();
      kit = createKit({ random: seededRandom(seed) });
      kit.settings({ actionGapSeconds: { min: 45, max: 180 } });
      const campaignId = addCampaign(kit);
      approved(campaignId);
      kit.engine = kit.newEngine({
        hook: (point) => {
          if (point.op === op && point.phase === "after") {
            kit.crash();
            throw new Error("killed");
          }
        },
      });
      await expect(kit.engine.tick()).rejects.toThrow();
      const loadsBefore = kit.world.log.length;
      kit.restart();
      const restartedAt = kit.clock.now().getTime();
      for (let i = 0; i < 20 && kit.world.log.length === loadsBefore; i++) await step(kit);
      const next = kit.world.log[loadsBefore];
      if (next === undefined) throw new Error("no page load after the restart");
      expect(next.at.getTime() - restartedAt).toBeGreaterThanOrEqual(45_000);
    },
  );
});

describe("breaks across kills and restarts", () => {
  const GAP_S = 60;
  const BREAK_EVERY_MAX = 3;
  const BREAK_MIN_MINUTES = 20;

  /**
   * What LinkedIn saw, grouped into pieces of work: log entries less than the minimum gap apart
   * belong to one piece (a fake call takes 2–20 s; the engine waits at least 60 s between pieces).
   * Returns the longest run of pieces with no pause of at least `breaks.minutesMin` between them.
   */
  function longestRunWithoutBreak(): number {
    const times = kit.world.log.map((entry) => entry.at.getTime()).sort((a, b) => a - b);
    let longest = 0;
    let run = 0;
    let last: number | null = null;
    for (const t of times) {
      if (last === null || t - last >= BREAK_MIN_MINUTES * MINUTE) run = 1;
      else if (t - last >= GAP_S * 1000) run += 1;
      longest = Math.max(longest, run);
      last = t;
    }
    return longest;
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    `never more than ${BREAK_EVERY_MAX} pieces of work without a ${BREAK_MIN_MINUTES}-minute pause, however often the process is killed and restarted (seed %i)`,
    async (seed) => {
      kit.close();
      kit = createKit({ random: seededRandom(seed) });
      kit.settings({
        actionGapSeconds: { min: GAP_S, max: GAP_S },
        breaks: { everyActionsMin: 2, everyActionsMax: BREAK_EVERY_MAX, minutesMin: BREAK_MIN_MINUTES, minutesMax: 25 },
        warmUp: { enabled: false },
        limits: { invitesPerDay: 200, invitesPerWeek: 1000, profileViewsPerDay: 1000 },
      });
      const c = seedCampaign(kit);
      for (let i = 0; i < 40; i++) seedApproved(kit, c);
      const chaos = seededRandom(1000 + seed);
      const kills = [
        { op: "viewProfile", phase: "after" },
        { op: "sendInvite", phase: "before" },
        { op: "sendInvite", phase: "after" },
      ] as const;
      for (let i = 0; i < 150; i++) {
        const roll = chaos();
        if (roll < 0.3) {
          // Killed between ticks and restarted at once.
          kit.restart();
          continue;
        }
        if (roll < 0.45) {
          // Killed in the middle of a driver call, then restarted at once.
          const kill = kills[Math.floor(chaos() * kills.length)] ?? kills[0];
          let fired = false;
          kit.engine = kit.newEngine({
            hook: (point) => {
              if (fired || point.op !== kill.op || point.phase !== kill.phase) return;
              fired = true;
              kit.crash();
              throw new Error("killed");
            },
          });
        }
        try {
          await step(kit);
        } catch {
          kit.restart();
        }
      }
      expect(kit.world.log.filter((entry) => entry.kind === "invite").length).toBeGreaterThan(10);
      expect(longestRunWithoutBreak()).toBeLessThanOrEqual(BREAK_EVERY_MAX);
    },
  );
});

describe("overlapping ticks", () => {
  it("a tick called while another is still awaiting the driver does nothing and wakes a second later", async () => {
    kit.close();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    kit = createKit({
      wrap: (driver) => ({
        ...driver,
        sendMessage: async (...args) => {
          calls += 1;
          await gate;
          return driver.sendMessage(...args);
        },
      }),
    });
    const a = seedAccepted(kit, seedCampaign(kit));
    const first = kit.engine.tick();
    // Let the first tick reach the send (it awaits the thread read first).
    for (let i = 0; i < 50 && calls === 0; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    const now = kit.clock.now();
    expect(await kit.engine.tick()).toEqual({ did: null, wakeAt: new Date(now.getTime() + 1_000) });
    expect(actionByKey(kit, `message1:${a.prospectId}`)?.status).toBe("in_progress");
    release();
    expect((await first).did).toContain("sent");
    expect(kit.world.messagesSentTo(a.spec.publicId)).toHaveLength(1);
    expect(actionByKey(kit, `message1:${a.prospectId}`)?.status).toBe("done");
    expect(calls).toBe(1);
    // Once the first has returned, ticks run again.
    kit.clock.set(new Date(kit.clock.now().getTime() + HOUR));
    expect((await kit.engine.tick()).did).not.toBeNull();
  });
});

describe("tick result", () => {
  it("wakeAt is always later than now", async () => {
    const campaignId = addCampaign(kit);
    for (let i = 0; i < 3; i++) approved(campaignId);
    for (let i = 0; i < 10; i++) {
      const result = await kit.engine.tick();
      expect(result.wakeAt.getTime()).toBeGreaterThan(kit.clock.now().getTime());
      kit.clock.set(result.wakeAt);
    }
  });
});

describe("picking due work", () => {
  beforeEach(() => {
    kit.settings({
      actionGapSeconds: { min: 1, max: 1 },
      breaks: { everyActionsMin: 1000, everyActionsMax: 1000, minutesMin: 1, minutesMax: 1 },
    });
  });

  it("takes follow-ups, then first messages, then withdrawals, then invites", async () => {
    const c = seedCampaign(kit);
    const inv = seedApproved(kit, c);
    const old = seedInvited(kit, c, 22);
    const first = seedAccepted(kit, c);
    seedConnectionsChecked(kit);
    const order: string[] = [];
    for (let i = 0; i < 4; i++) order.push((await step(kit)).did ?? "");
    // The first message makes a follow-up due at once (zero delay), which then goes before the rest.
    expect(order.map((did) => did.split(":")[0])).toEqual(["first message", "follow-up", "withdraw", "invite"]);
    expect(prospect(kit, first.prospectId).stage).toBe("completed");
    expect(prospect(kit, old.prospectId).stage).toBe("withdrawn");
    expect(prospect(kit, inv.prospectId).stage).toBe("invited");
  });

  it("skips a kind whose budget is spent while lower kinds still run", async () => {
    kit.settings({ limits: { messagesPerDay: 0 } });
    const c = seedCampaign(kit);
    const a = seedAccepted(kit, c);
    const p = seedApproved(kit, c);
    await step(kit);
    expect(prospect(kit, p.prospectId).stage).toBe("invited");
    expect(prospect(kit, a.prospectId).stage).toBe("accepted");
    expect(kit.world.messagesSentTo(a.spec.publicId)).toHaveLength(0);
  });

  it("a follow-up of a campaign with no follow-up text runs with the message budget spent; one with a text waits", async () => {
    const later = { followUpDelayMinHours: 24, followUpDelayMaxHours: 24 };
    const blank = seedAccepted(kit, seedCampaign(kit, { ...later, followUp: "  " }));
    const real = seedAccepted(kit, seedCampaign(kit, later));
    await step(kit);
    await step(kit);
    expect([blank, real].map((p) => prospect(kit, p.prospectId).stage)).toEqual(["message_sent", "message_sent"]);
    kit.settings({ limits: { messagesPerDay: 0 } });
    kit.clock.set(new Date(Math.max(...[blank, real].map((p) => prospect(kit, p.prospectId).nextActionAt?.getTime() ?? 0))));
    expect((await step(kit)).did).toContain("follow-up: none for");
    expect(prospect(kit, blank.prospectId).stage).toBe("completed");
    expect((await step(kit)).did).toBeNull();
    expect(prospect(kit, real.prospectId).stage).toBe("message_sent");
    expect(kit.world.messagesSentTo(real.spec.publicId)).toHaveLength(1);
  });

  it("with invites spent, withdrawals and messages still run; with profile views spent, neither invites nor withdrawals do", async () => {
    kit.settings({ warmUp: { enabled: false }, limits: { invitesPerDay: 0 } });
    const c = seedCampaign(kit);
    const p = seedApproved(kit, c);
    const old = seedInvited(kit, c, 22);
    seedConnectionsChecked(kit);
    await step(kit);
    expect(prospect(kit, old.prospectId).stage).toBe("withdrawn");
    expect(prospect(kit, p.prospectId).stage).toBe("approved");

    kit.settings({ limits: { invitesPerDay: 15, profileViewsPerDay: 1 } });
    expect((await step(kit)).did).toBeNull();
    expect(prospect(kit, p.prospectId).stage).toBe("approved");
  });

  it("campaigns take turns within a kind", async () => {
    const a = seedCampaign(kit, { name: "A" });
    const b = seedCampaign(kit, { name: "B" });
    const a1 = seedApproved(kit, a);
    const a2 = seedApproved(kit, a);
    const b1 = seedApproved(kit, b);
    const b2 = seedApproved(kit, b);
    const invitedOrder: number[] = [];
    const ids = [a1, a2, b1, b2].map((x) => x.prospectId);
    for (let i = 0; i < 12 && invitedOrder.length < 4; i++) {
      await step(kit);
      for (const id of ids) if (prospect(kit, id).stage === "invited" && !invitedOrder.includes(id)) invitedOrder.push(id);
    }
    expect(invitedOrder).toEqual([a1.prospectId, b1.prospectId, a2.prospectId, b2.prospectId]);
  });

  it("does not act on a paused campaign", async () => {
    const c = seedCampaign(kit, { status: "paused" });
    seedApproved(kit, c);
    seedAccepted(kit, c);
    expect((await kit.engine.tick()).did).toBeNull();
    expect(kit.world.log).toHaveLength(0);
  });

  it("reconciles before anything else, even in a paused campaign", async () => {
    const c = seedCampaign(kit);
    const a = seedAccepted(kit, c);
    seedApproved(kit, c);
    kit.world.failNext("sendMessage", "timeout_after_effect");
    await step(kit);
    kit.db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, c)).run();
    const result = await step(kit);
    expect(result.did).toContain("reconcile message1");
    expect(prospect(kit, a.prospectId).stage).toBe("message_sent");
  });
});

describe("pickDueWork on a mixed set of due work", () => {
  const DAY = 24 * 60 * MINUTE;
  const ago = (ms: number) => new Date(START.getTime() - ms);
  let key = 0;
  function row(values: Partial<typeof actions.$inferInsert> & Pick<typeof actions.$inferInsert, "type">) {
    key += 1;
    kit.db.insert(actions).values({ status: "done", idempotencyKey: `seed:${key}`, attempts: 1, startedAt: ago(DAY), finishedAt: ago(DAY), ...values }).run();
  }
  function at(campaignId: number, values: Parameters<typeof addProspect>[3]) {
    const { personId } = addPerson(kit);
    return addProspect(kit, campaignId, personId, values);
  }
  const pick = () => {
    const work = pickDueWork(kit.db, getSettings(kit.db), START);
    return work === null ? null : { kind: work.kind, prospectId: "target" in work ? work.target.prospect.id : null };
  };

  it("picks reconcile, connections check, follow-ups, first messages, withdrawals, invites, in that order, campaigns in turn", () => {
    kit.settings({ warmUp: { enabled: false } });
    const a = addCampaign(kit, { name: "A" });
    const b = addCampaign(kit, { name: "B" });
    const archived = addCampaign(kit, { name: "Archived", status: "archived" });
    const paused = addCampaign(kit, { name: "Paused", status: "paused" });

    // Unknown step rows: an invite in A (oldest), a first message in paused, one in an archived campaign.
    const reconcileInvite = at(a, { stage: "approved" });
    row({ type: "invite", status: "unknown", idempotencyKey: `invite:${reconcileInvite}`, prospectId: reconcileInvite, campaignId: a, startedAt: ago(3 * HOUR), finishedAt: null });
    const reconcileMessage = at(paused, { stage: "accepted", nextActionAt: ago(DAY) });
    row({ type: "message", status: "unknown", idempotencyKey: `message1:${reconcileMessage}`, prospectId: reconcileMessage, campaignId: paused, startedAt: ago(2 * HOUR), finishedAt: null });
    const archivedUnknown = at(archived, { stage: "accepted", nextActionAt: ago(DAY) });
    row({ type: "message", status: "unknown", idempotencyKey: `message1:${archivedUnknown}`, prospectId: archivedUnknown, campaignId: archived, startedAt: ago(4 * HOUR), finishedAt: null });

    // Follow-ups due in A and B and paused; A sent one more recently than B, so B goes first.
    const followA = at(a, { stage: "message_sent", nextActionAt: ago(2 * HOUR) });
    const followB1 = at(b, { stage: "message_sent", nextActionAt: ago(HOUR) });
    const followB2 = at(b, { stage: "message_sent", nextActionAt: ago(3 * HOUR) });
    at(paused, { stage: "message_sent", nextActionAt: ago(DAY) });
    row({ type: "message", idempotencyKey: "followup:900", campaignId: a, startedAt: ago(HOUR) });
    row({ type: "message", idempotencyKey: "followup:901", campaignId: b, startedAt: ago(DAY) });
    // First messages due in A and B (neither sent one before: lowest campaign id first), one not yet due.
    const firstA = at(a, { stage: "accepted", nextActionAt: ago(HOUR) });
    at(b, { stage: "accepted", nextActionAt: ago(2 * HOUR) });
    at(a, { stage: "accepted", nextActionAt: new Date(START.getTime() + HOUR) });
    // Old invitations in A and B, one young one; B withdrew one before, so A goes first, oldest invite first.
    const oldA1 = at(a, { stage: "invited", invitedAt: ago(25 * DAY) });
    const oldA2 = at(a, { stage: "invited", invitedAt: ago(30 * DAY) });
    at(b, { stage: "invited", invitedAt: ago(40 * DAY) });
    at(a, { stage: "invited", invitedAt: ago(2 * DAY) });
    row({ type: "withdraw", idempotencyKey: "withdraw:902", campaignId: b, startedAt: ago(2 * DAY) });
    // Approved in A and B; A invited more recently, so B goes first, earliest approved first.
    at(a, { stage: "approved", approvedAt: ago(5 * DAY) });
    const approvedB1 = at(b, { stage: "approved", approvedAt: ago(DAY) });
    const approvedB2 = at(b, { stage: "approved", approvedAt: ago(3 * DAY) });
    at(paused, { stage: "approved", approvedAt: ago(9 * DAY) });
    row({ type: "invite", idempotencyKey: "invite:903", campaignId: a, startedAt: ago(DAY) });
    row({ type: "invite", idempotencyKey: "invite:904", campaignId: b, startedAt: ago(2 * DAY) });

    expect(pick()).toEqual({ kind: "reconcile", prospectId: reconcileInvite });
    // An invite reconcile needs a profile view; with none left, the message reconcile goes first.
    kit.settings({ limits: { profileViewsPerDay: 0 } });
    expect(pick()).toEqual({ kind: "reconcile", prospectId: reconcileMessage });
    kit.settings({ limits: { profileViewsPerDay: 80 } });
    kit.db.update(actions).set({ status: "done" }).where(eq(actions.idempotencyKey, `invite:${reconcileInvite}`)).run();
    kit.db.update(actions).set({ status: "done" }).where(eq(actions.idempotencyKey, `message1:${reconcileMessage}`)).run();

    expect(pick()).toEqual({ kind: "connections_check", prospectId: null });
    row({ type: "connections_check", startedAt: ago(HOUR) });

    expect(pick()).toEqual({ kind: "followup", prospectId: followB2 });
    kit.db.update(prospects).set({ nextActionAt: new Date(START.getTime() + HOUR) }).where(inArray(prospects.id, [followA, followB1, followB2])).run();
    expect(pick()).toEqual({ kind: "message1", prospectId: firstA });

    kit.settings({ limits: { messagesPerDay: 0 } });
    expect(pick()).toEqual({ kind: "withdraw", prospectId: oldA2 });
    expect(oldA1).toBeLessThan(oldA2);

    // An overdue invitation needs only a profile view to be picked: the view may find a missed acceptance.
    kit.settings({ limits: { withdrawalsPerDay: 0 } });
    expect(pick()).toEqual({ kind: "withdraw", prospectId: oldA2 });
    // The handler then puts a still pending one off until the withdrawal budget opens.
    kit.db.update(prospects).set({ nextActionAt: new Date(START.getTime() + DAY) }).where(eq(prospects.stage, "invited")).run();
    expect(pick()).toEqual({ kind: "invite", prospectId: approvedB2 });
    expect(approvedB1).toBeLessThan(approvedB2);

    kit.settings({ limits: { invitesPerDay: 0 } });
    expect(pick()).toBeNull();
    kit.settings({ limits: { invitesPerDay: 15, withdrawalsPerDay: 10, profileViewsPerDay: 0 } });
    expect(pick()).toBeNull();
  });
});
