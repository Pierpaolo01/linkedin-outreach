/**
 * What happens when things go wrong: unknown send results and their reconcile, a process killed
 * mid-action, safety stops, and driver errors.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { campaigns, safetyStops } from "../db/schema";
import type { DriverOp, KillHook, KillPhase } from "../linkedin/fake/world";
import { activeSafetyStop, resumeSafetyStop } from "./safetyStop";
import {
  actionByKey,
  actionRows,
  createKit,
  events,
  HOUR,
  MINUTE,
  prospect,
  runUntil,
  seedAccepted,
  seedApproved,
  seedCampaign,
  seedConnectionsChecked,
  seedInvited,
  START,
  step,
  type Kit,
  type KitOptions,
} from "./testKit";

let kit: Kit;
function start(options: KitOptions = {}) {
  kit = createKit(options);
  kit.settings({
    actionGapSeconds: { min: 1, max: 1 },
    breaks: { everyActionsMin: 1000, everyActionsMax: 1000, minutesMin: 1, minutesMax: 1 },
  });
}
beforeEach(() => start());
afterEach(() => kit.close());

class Killed extends Error {}

/** Throws `Killed` the first time the call reaches the point; optionally does something first (like closing the database). */
function killOnce(op: DriverOp, phase: KillPhase, before?: () => void): KillHook {
  let fired = false;
  return (point) => {
    if (fired || point.op !== op || point.phase !== phase) return;
    fired = true;
    before?.();
    throw new Killed(`killed at ${op}/${phase}`);
  };
}

/** Runs `run` once with a hook on a fresh engine, then puts back a plain engine. */
function withHook(hook: KillHook) {
  kit.engine = kit.newEngine({ hook });
}

const stage = (id: number) => prospect(kit, id).stage;
const until = (done: () => boolean, max = 60) => runUntil(kit, done, max);
const invitesTo = (publicId: string) => kit.world.invitesTo(publicId).length;
const messagesTo = (publicId: string) => kit.world.messagesSentTo(publicId).map((entry) => entry.text);
const withdrawals = () => kit.world.log.filter((entry) => entry.kind === "withdraw").length;

describe("reconcile an invite of unknown result", () => {
  it("a timeout after the invite went out: the profile shows pending, so the row is done and the prospect invited", async () => {
    const p = seedApproved(kit, seedCampaign(kit));
    kit.world.failNext("sendInvite", "timeout_after_effect");
    await step(kit);
    const row = actionByKey(kit, `invite:${p.prospectId}`);
    expect(row).toMatchObject({ status: "unknown", errorKind: "error" });
    expect(stage(p.prospectId)).toBe("approved");
    const result = await step(kit);
    expect(result.did).toContain("reconcile invite");
    expect(actionByKey(kit, `invite:${p.prospectId}`)?.status).toBe("done");
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "invited", invitedAt: row?.startedAt });
    expect(invitesTo(p.spec.publicId)).toBe(1);
  });

  it("a timeout before the invite went out: back to planned, then sent once by the normal path", async () => {
    const p = seedApproved(kit, seedCampaign(kit));
    kit.world.failNext("sendInvite", "timeout_before_effect");
    await step(kit);
    await step(kit);
    expect(actionByKey(kit, `invite:${p.prospectId}`)?.status).toBe("planned");
    await until(() => stage(p.prospectId) === "invited");
    expect(invitesTo(p.spec.publicId)).toBe(1);
    expect(actionByKey(kit, `invite:${p.prospectId}`)).toMatchObject({ status: "done", attempts: 2 });
  });

  it.each([
    ["before", 1, 2],
    ["after", 1, 1],
  ] as const)("killed at %s: reconciled and sent exactly once", async (phase, invites, attempts) => {
    const p = seedApproved(kit, seedCampaign(kit));
    withHook(killOnce("sendInvite", phase));
    await step(kit);
    expect(actionByKey(kit, `invite:${p.prospectId}`)?.status).toBe("unknown");
    await until(() => stage(p.prospectId) === "invited");
    expect(invitesTo(p.spec.publicId)).toBe(invites);
    expect(actionByKey(kit, `invite:${p.prospectId}`)?.attempts).toBe(attempts);
  });

  it.each([
    ["a minute under 14 days old: back to planned", -MINUTE, "approved", "planned"],
    ["14 days old: too old to retry safely, held for review", 0, "needs_review", "unknown"],
  ] as const)("Connect shown again for an unknown invite %s", async (_label, offset, expectedStage, expectedStatus) => {
    // The invite may have gone out and been withdrawn by hand meanwhile; LinkedIn then blocks a new
    // invite for about three weeks, and a second one would reach the person twice.
    const p = seedApproved(kit, seedCampaign(kit));
    kit.world.failNext("sendInvite", "timeout_before_effect");
    await step(kit);
    const claimedAt = actionByKey(kit, `invite:${p.prospectId}`)?.startedAt;
    if (claimedAt == null) throw new Error("no claim time");
    kit.clock.set(new Date(claimedAt.getTime() + 14 * 24 * HOUR + offset));
    const result = await step(kit);
    expect(result.did).toContain("reconcile invite");
    expect(stage(p.prospectId)).toBe(expectedStage);
    expect(actionByKey(kit, `invite:${p.prospectId}`)?.status).toBe(expectedStatus);
    if (expectedStage === "needs_review") {
      expect(prospect(kit, p.prospectId).reviewReason).toMatch(/invite.*unknown.*too old to retry safely/);
      for (let i = 0; i < 5; i++) await step(kit);
    }
    expect(invitesTo(p.spec.publicId)).toBe(0);
  });

  it("the profile now shows 1st degree: needs review, not accepted (decision 32)", async () => {
    const p = seedApproved(kit, seedCampaign(kit), { acceptsAfterHours: 0.1 });
    kit.world.failNext("sendInvite", "timeout_after_effect");
    await step(kit);
    kit.clock.set(new Date(START.getTime() + HOUR));
    await step(kit);
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(prospect(kit, p.prospectId).reviewReason).toContain("connected");
    expect(actionByKey(kit, `invite:${p.prospectId}`)?.status).toBe("unknown");
  });

  it("a reconcile read that fails stays unknown, waits 30 minutes, and after 3 failures holds for review", async () => {
    const p = seedApproved(kit, seedCampaign(kit));
    kit.world.failNext("sendInvite", "timeout_before_effect");
    await step(kit);
    for (let failure = 1; failure <= 3; failure++) {
      kit.world.failNext("viewProfile", "timeout_before_effect");
      const result = await kit.engine.tick();
      expect(result.did).toContain("reconcile invite");
      const row = actionByKey(kit, `invite:${p.prospectId}`);
      expect(row?.status).toBe("unknown");
      expect(row?.detail).toMatchObject({ reconcileFailures: failure });
      if (failure < 3) {
        const next = prospect(kit, p.prospectId).nextActionAt;
        expect(next?.getTime()).toBe(kit.clock.now().getTime() + 30 * MINUTE);
        kit.clock.set(new Date((next?.getTime() ?? 0) - MINUTE));
        expect((await kit.engine.tick()).did).toBeNull();
        kit.clock.set(next ?? START);
      }
    }
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(invitesTo(p.spec.publicId)).toBe(0);
  });
});

describe("reconcile a message of unknown result", () => {
  it("first message, timeout after it went out: judged sent, moved to message_sent", async () => {
    const p = seedAccepted(kit, seedCampaign(kit));
    kit.world.failNext("sendMessage", "timeout_after_effect");
    await step(kit);
    const row = actionByKey(kit, `message1:${p.prospectId}`);
    expect(row?.status).toBe("unknown");
    await step(kit);
    expect(actionByKey(kit, `message1:${p.prospectId}`)?.status).toBe("done");
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "message_sent", firstMessageSentAt: row?.startedAt });
    expect(prospect(kit, p.prospectId).nextActionAt).not.toBeNull();
    expect(messagesTo(p.spec.publicId)).toHaveLength(1);
  });

  it("first message, timeout before it went out: planned again and sent once with the frozen text, though the template changed and no longer renders", async () => {
    const c = seedCampaign(kit);
    const p = seedAccepted(kit, c);
    kit.world.failNext("sendMessage", "timeout_before_effect");
    await step(kit);
    kit.db.update(campaigns).set({ firstMessage: "A different text that cannot be written: {{company}}" }).where(eq(campaigns.id, c)).run();
    await step(kit);
    expect(actionByKey(kit, `message1:${p.prospectId}`)?.status).toBe("planned");
    await until(() => stage(p.prospectId) === "message_sent");
    expect(messagesTo(p.spec.publicId)).toEqual(["Hi Test, thanks for connecting."]);
    expect(actionByKey(kit, `message1:${p.prospectId}`)).toMatchObject({ status: "done", attempts: 2 });
  });

  it.each([
    ["before", 2],
    ["typed", 2],
    ["after", 1],
  ] as const)("first message killed at %s: sent exactly once in the end", async (phase, attempts) => {
    const p = seedAccepted(kit, seedCampaign(kit));
    withHook(killOnce("sendMessage", phase));
    await step(kit);
    expect(actionByKey(kit, `message1:${p.prospectId}`)?.status).toBe("unknown");
    await until(() => stage(p.prospectId) === "message_sent");
    expect(messagesTo(p.spec.publicId)).toHaveLength(1);
    expect(kit.world.draft(p.spec.publicId)).toBeNull();
    expect(actionByKey(kit, `message1:${p.prospectId}`)?.attempts).toBe(attempts);
  });

  it("a send that keeps failing before its effect is tried 3 times, then the prospect is held for review", async () => {
    const p = seedAccepted(kit, seedCampaign(kit));
    for (let attempt = 1; attempt <= 3; attempt++) {
      kit.world.failNext("sendMessage", "timeout_before_effect");
      await step(kit);
      expect(actionByKey(kit, `message1:${p.prospectId}`)).toMatchObject({ status: "unknown", attempts: attempt });
      await step(kit);
      expect(actionByKey(kit, `message1:${p.prospectId}`)?.status).toBe("planned");
    }
    await step(kit);
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(prospect(kit, p.prospectId).reviewReason).toBe("tried 3 times without a confirmed result");
    expect(actionByKey(kit, `message1:${p.prospectId}`)).toMatchObject({ status: "planned", attempts: 3 });
    const loads = kit.world.log.length;
    for (let i = 0; i < 5; i++) await step(kit);
    expect(kit.world.log).toHaveLength(loads);
    expect(messagesTo(p.spec.publicId)).toHaveLength(0);
  });

  it("first message, the user wrote meanwhile: unclear, held for review, nothing sent", async () => {
    // Connected an hour before START; the user writes by hand five minutes after START.
    const p = seedAccepted(kit, seedCampaign(kit), { userWritesAfterHours: 1 + 5 / 60 });
    kit.world.failNext("sendMessage", "timeout_before_effect");
    await step(kit);
    kit.clock.set(new Date(START.getTime() + 10 * MINUTE));
    await step(kit);
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(actionByKey(kit, `message1:${p.prospectId}`)?.status).toBe("unknown");
    for (let i = 0; i < 5; i++) await step(kit);
    expect(messagesTo(p.spec.publicId)).toHaveLength(0);
  });

  it.each([
    ["timeout_after_effect", 2, 1],
    ["timeout_before_effect", 2, 2],
  ] as const)("follow-up, %s: completed with exactly two messages sent", async (fault, messages, attempts) => {
    const p = seedAccepted(kit, seedCampaign(kit));
    await step(kit);
    expect(stage(p.prospectId)).toBe("message_sent");
    kit.world.failNext("sendMessage", fault);
    await step(kit);
    expect(actionByKey(kit, `followup:${p.prospectId}`)?.status).toBe("unknown");
    await until(() => stage(p.prospectId) === "completed");
    expect(messagesTo(p.spec.publicId)).toHaveLength(messages);
    expect(actionByKey(kit, `followup:${p.prospectId}`)).toMatchObject({ status: "done", attempts });
    expect(prospect(kit, p.prospectId).followUpSentAt).not.toBeNull();
  });
});

describe("reconcile a withdrawal of unknown result", () => {
  it("timeout after it took effect: the profile shows Connect, so done and withdrawn", async () => {
    const p = seedInvited(kit, seedCampaign(kit), 22);
    seedConnectionsChecked(kit);
    kit.world.failNext("withdrawInvite", "timeout_after_effect");
    await step(kit);
    expect(actionByKey(kit, `withdraw:${p.prospectId}`)?.status).toBe("unknown");
    await step(kit);
    expect(actionByKey(kit, `withdraw:${p.prospectId}`)?.status).toBe("done");
    expect(stage(p.prospectId)).toBe("withdrawn");
    expect(withdrawals()).toBe(1);
  });

  it("timeout before it took effect: still pending, so planned again and withdrawn once", async () => {
    const p = seedInvited(kit, seedCampaign(kit), 22);
    seedConnectionsChecked(kit);
    kit.world.failNext("withdrawInvite", "timeout_before_effect");
    await step(kit);
    await step(kit);
    expect(actionByKey(kit, `withdraw:${p.prospectId}`)?.status).toBe("planned");
    await until(() => stage(p.prospectId) === "withdrawn");
    expect(withdrawals()).toBe(1);
  });

  it("the person accepted meanwhile: held for review", async () => {
    const p = seedInvited(kit, seedCampaign(kit), 22, { acceptsAfterHours: 22 * 24 + 0.1 });
    seedConnectionsChecked(kit);
    kit.world.failNext("withdrawInvite", "timeout_before_effect");
    await step(kit);
    kit.clock.set(new Date(START.getTime() + 20 * MINUTE));
    await step(kit);
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(withdrawals()).toBe(0);
  });
});

describe("a process killed mid-action (the database closes)", () => {
  it.each([
    ["sendMessage", "before", 1, 2],
    ["sendMessage", "typed", 1, 2],
    ["sendMessage", "after", 1, 1],
  ] as const)("killed at %s/%s after the claim: the tick rejects, and a new engine sends exactly once", async (op, phase, sent, attempts) => {
    const p = seedAccepted(kit, seedCampaign(kit));
    withHook(killOnce(op, phase, () => kit.crash()));
    await expect(kit.engine.tick()).rejects.toThrow();
    kit.restart();
    expect(actionByKey(kit, `message1:${p.prospectId}`)?.status).toBe("in_progress");
    const first = await kit.engine.tick();
    expect(actionByKey(kit, `message1:${p.prospectId}`)?.status).not.toBe("in_progress");
    expect(first.wakeAt.getTime()).toBeGreaterThan(kit.clock.now().getTime());
    kit.clock.set(first.wakeAt);
    await until(() => stage(p.prospectId) === "message_sent");
    expect(messagesTo(p.spec.publicId)).toHaveLength(sent);
    expect(actionByKey(kit, `message1:${p.prospectId}`)).toMatchObject({ status: "done", attempts });
  });

  it("killed after the invite went out: a new engine confirms it and never invites again", async () => {
    const p = seedApproved(kit, seedCampaign(kit));
    withHook(killOnce("sendInvite", "after", () => kit.crash()));
    await expect(kit.engine.tick()).rejects.toThrow();
    kit.restart();
    await until(() => stage(p.prospectId) === "invited");
    for (let i = 0; i < 5; i++) await step(kit);
    expect(invitesTo(p.spec.publicId)).toBe(1);
  });

  it("killed during a profile view: after the restart the read is failed as interrupted, and the invite goes out once", async () => {
    const p = seedApproved(kit, seedCampaign(kit));
    withHook(killOnce("viewProfile", "after", () => kit.crash()));
    await expect(kit.engine.tick()).rejects.toThrow();
    kit.restart();
    await until(() => stage(p.prospectId) === "invited");
    const views = actionRows(kit).filter((row) => row.type === "profile_view");
    expect(views.map((row) => [row.status, row.errorKind])).toEqual([
      ["failed", "interrupted"],
      ["done", null],
    ]);
    expect(views[0]?.finishedAt).not.toBeNull();
    expect(actionRows(kit).some((row) => row.status === "unknown" || row.status === "in_progress")).toBe(false);
    expect(invitesTo(p.spec.publicId)).toBe(1);
  });

  it("a database error is never swallowed, even from inside a driver failure", async () => {
    seedApproved(kit, seedCampaign(kit));
    withHook(killOnce("viewProfile", "before", () => kit.crash()));
    await expect(kit.engine.tick()).rejects.toThrow(/database|not open/i);
  });
});

describe("safety stops", () => {
  it.each(["logged_out", "checkpoint", "restricted"] as const)(
    "%s on a read: the read fails, a safety stop is raised, nothing else happens until the user resumes",
    async (kind) => {
      const p = seedApproved(kit, seedCampaign(kit));
      kit.world.breakSession(kind);
      await step(kit);
      expect(activeSafetyStop(kit.db)).toMatchObject({ reason: kind });
      expect(actionRows(kit).map((row) => [row.type, row.status, row.errorKind])).toEqual([["profile_view", "failed", kind]]);
      expect(stage(p.prospectId)).toBe("approved");
      for (let i = 0; i < 3; i++) expect((await step(kit)).did).toBeNull();
      expect(actionRows(kit)).toHaveLength(1);

      kit.world.fixSession();
      resumeSafetyStop(kit.db, kit.clock.now());
      kit.engine = kit.newEngine(); // the old driver handle latched the error, as the live driver does
      await until(() => stage(p.prospectId) === "invited");
      expect(invitesTo(p.spec.publicId)).toBe(1);
    },
  );

  it("a checkpoint during a send leaves the row unknown and raises the stop; after resume it is reconciled, not resent blindly", async () => {
    const p = seedApproved(kit, seedCampaign(kit));
    withHook((point) => {
      if (point.op === "sendInvite" && point.phase === "before") kit.world.breakSession("checkpoint");
    });
    await step(kit);
    expect(actionByKey(kit, `invite:${p.prospectId}`)).toMatchObject({ status: "unknown", errorKind: "checkpoint" });
    expect(activeSafetyStop(kit.db)?.reason).toBe("checkpoint");
    kit.world.fixSession();
    resumeSafetyStop(kit.db, kit.clock.now());
    kit.engine = kit.newEngine();
    const next = await step(kit);
    expect(next.did).toContain("reconcile invite");
    await until(() => stage(p.prospectId) === "invited");
    expect(invitesTo(p.spec.publicId)).toBe(1);
  });

  it("an unexpected page holds the prospect; three in a row raise unexpected_pages; right after resume one more does not", async () => {
    const c = seedCampaign(kit);
    const ps = [1, 2, 3, 4].map(() => seedApproved(kit, c));
    for (let i = 0; i < 3; i++) {
      kit.world.failNext("viewProfile", "unexpected");
      await step(kit);
    }
    expect(ps.slice(0, 3).map((p) => stage(p.prospectId))).toEqual(["needs_review", "needs_review", "needs_review"]);
    expect(actionRows(kit).every((row) => row.status === "failed" && row.errorKind === "unexpected")).toBe(true);
    expect(activeSafetyStop(kit.db)?.reason).toBe("unexpected_pages");

    resumeSafetyStop(kit.db, kit.clock.now());
    kit.clock.advance(MINUTE);
    const fourth = ps[3];
    if (fourth === undefined) throw new Error("missing prospect");
    kit.world.failNext("viewProfile", "unexpected");
    await step(kit);
    expect(stage(fourth.prospectId)).toBe("needs_review");
    expect(activeSafetyStop(kit.db)).toBeNull();
  });

  it("an interrupted read does not count toward the unexpected-page streak, nor break it", async () => {
    const c = seedCampaign(kit);
    [1, 2, 3, 4].forEach(() => seedApproved(kit, c));
    for (let i = 0; i < 2; i++) {
      kit.world.failNext("viewProfile", "unexpected");
      await step(kit);
    }
    withHook(killOnce("viewProfile", "after", () => kit.crash()));
    await expect(kit.engine.tick()).rejects.toThrow();
    kit.restart();
    // The restart closes the interrupted read; two unexpected pages and it make no stop.
    const first = await kit.engine.tick();
    expect(actionRows(kit).filter((row) => row.errorKind === "interrupted")).toHaveLength(1);
    expect(activeSafetyStop(kit.db)).toBeNull();
    kit.clock.set(first.wakeAt);
    // The next unexpected page is the third in a row.
    kit.world.failNext("viewProfile", "unexpected");
    await step(kit);
    expect(activeSafetyStop(kit.db)?.reason).toBe("unexpected_pages");
  });

  it("two unexpected pages and a normal one raise nothing", async () => {
    const c = seedCampaign(kit);
    [1, 2, 3].forEach(() => seedApproved(kit, c));
    kit.world.failNext("viewProfile", "unexpected");
    await step(kit);
    kit.world.failNext("viewProfile", "unexpected");
    await step(kit);
    await step(kit);
    expect(activeSafetyStop(kit.db)).toBeNull();
  });

  it("LinkedIn's invitation limit: row back to planned, stop raised, invites stay off for the cool-down while messages go on after resume", async () => {
    kit.close();
    start({ world: { weeklyInviteCap: 0 } });
    const c = seedCampaign(kit);
    const p = seedApproved(kit, c);
    await step(kit);
    // LinkedIn's own refusal: the claim is given back, so it does not use up one of the 3 attempts.
    expect(actionByKey(kit, `invite:${p.prospectId}`)).toMatchObject({ status: "planned", errorKind: "limit_hit", attempts: 0 });
    const stop = activeSafetyStop(kit.db);
    expect(stop?.reason).toBe("limit_hit");
    const until7 = stop?.invitesBlockedUntil?.getTime() ?? 0;
    expect(until7 - (actionByKey(kit, `invite:${p.prospectId}`)?.finishedAt?.getTime() ?? 0)).toBe(7 * 24 * HOUR);
    expect(stage(p.prospectId)).toBe("approved");

    resumeSafetyStop(kit.db, kit.clock.now());
    kit.engine = kit.newEngine();
    const a = seedAccepted(kit, c);
    await until(() => stage(a.prospectId) === "message_sent");
    const views = () => kit.world.log.filter((entry) => entry.kind === "profile_view" && entry.publicId === p.spec.publicId).length;
    const viewsBefore = views();
    for (let i = 0; i < 10; i++) await step(kit);
    expect(views()).toBe(viewsBefore);

    kit.clock.set(new Date(until7 + 24 * HOUR));
    await until(() => views() > viewsBefore, 200);
    expect(kit.db.select().from(safetyStops).all().length).toBeGreaterThanOrEqual(1);
  });
});

describe("other driver errors on a read", () => {
  it("fail the read, keep the stage and retry the prospect 30 minutes later", async () => {
    const p = seedApproved(kit, seedCampaign(kit));
    kit.world.failNext("viewProfile", "timeout_before_effect");
    await kit.engine.tick();
    expect(actionRows(kit).map((row) => [row.type, row.status, row.errorKind])).toEqual([["profile_view", "failed", "error"]]);
    expect(stage(p.prospectId)).toBe("approved");
    const next = prospect(kit, p.prospectId).nextActionAt;
    expect(next?.getTime()).toBe(kit.clock.now().getTime() + 30 * MINUTE);
    kit.clock.advance(MINUTE);
    expect((await kit.engine.tick()).did).toBeNull();
    kit.clock.set(next ?? START);
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("invited");
    expect(activeSafetyStop(kit.db)).toBeNull();
  });
});

describe("event log", () => {
  it("has a line for the safety stop", async () => {
    seedApproved(kit, seedCampaign(kit));
    kit.world.breakSession("logged_out");
    await step(kit);
    expect(events(kit).some((message) => message.startsWith("Safety stop (logged_out)"))).toBe(true);
  });
});
