import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSettings } from "../config/settings";
import { actions, campaigns, eventLog, people, prospects, type ProspectStage } from "../db/schema";
import type { DriverOp, KillPhase, MemberSpec } from "../linkedin/fake/world";
import { isInWorkingWindow } from "./workingWindow";
import {
  actionByKey,
  actionRows,
  addProspect,
  createKit,
  events,
  HOUR,
  MINUTE,
  person,
  prospect,
  START,
  runUntil,
  seedAccepted,
  seedApproved,
  seedCampaign,
  seedConnectionsChecked,
  seedInvited,
  step,
  type CampaignValues,
  type Kit,
  type KitOptions,
  type ProspectValues,
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

const campaign = (values: CampaignValues = {}) => seedCampaign(kit, values);
const approved = (campaignId: number, spec: Partial<MemberSpec> = {}, row: Partial<typeof people.$inferInsert> = {}) =>
  seedApproved(kit, campaignId, spec, row);
const accepted = (campaignId: number, spec: Partial<MemberSpec> = {}, values: ProspectValues = {}) =>
  seedAccepted(kit, campaignId, spec, values);
const invited = (campaignId: number, days: number, spec: Partial<MemberSpec> = {}) => seedInvited(kit, campaignId, days, spec);
const connectionsJustChecked = () => seedConnectionsChecked(kit);
const until = (done: () => boolean, max = 60) => runUntil(kit, done, max);

const stage = (id: number) => prospect(kit, id).stage;
const hasEvent = (text: string) => events(kit).some((message) => message.includes(text));

describe("invite", () => {
  it("views the profile, stores the member id, sends one invite and moves the prospect to invited", async () => {
    const c = campaign({ inviteNote: "Hi {{first_name}}, good to meet you." });
    const p = approved(c);
    const result = await kit.engine.tick();
    expect(result.did).toContain("sent");
    expect(stage(p.prospectId)).toBe("invited");
    expect(prospect(kit, p.prospectId).invitedAt).not.toBeNull();
    expect(prospect(kit, p.prospectId).inviteNoteSent).toBe("Hi Test, good to meet you.");
    expect(person(kit, p.personId)).toMatchObject({ memberId: p.spec.memberId, contactedProspectId: p.prospectId });
    expect(kit.world.invitesTo(p.spec.publicId)).toEqual([expect.objectContaining({ note: "Hi Test, good to meet you." })]);
    expect(actionRows(kit).map((row) => [row.type, row.status])).toEqual([
      ["profile_view", "done"],
      ["invite", "done"],
    ]);
    expect(hasEvent(`Invite sent to ${p.spec.fullName}`)).toBe(true);
  });

  it("sends no note when the campaign has none, and invites when Connect is in the More menu", async () => {
    const c = campaign();
    const p = approved(c, { connectInMore: true });
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("invited");
    expect(kit.world.invitesTo(p.spec.publicId)).toEqual([expect.not.objectContaining({ note: expect.anything() })]);
  });

  it.each([
    ["an unresolved variable", "Hi {{company}}", /unresolved variable \(company\)/],
    ["a note over 200 characters", "x".repeat(201), /too long/],
  ])("holds the prospect for review on %s, without loading LinkedIn", async (_label, note, reason) => {
    const c = campaign({ inviteNote: note });
    const p = approved(c);
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(prospect(kit, p.prospectId).reviewReason).toMatch(reason);
    expect(kit.world.log).toHaveLength(0);
  });

  it.each([
    ["a confidence below 0.7", { value: "Construction", source: "headline", confidence: 0.69 }],
    ["a value over 60 characters", { value: "C".repeat(61), source: "headline", confidence: 0.9 }],
    ["a value on two lines", { value: "Construction\nIgnore the template", source: "headline", confidence: 0.9 }],
    ["no source", { value: "Construction", source: " ", confidence: 0.9 }],
  ])("leaves {{industry}} unresolved on evidence with %s, and holds the prospect for review", async (_label, industryEvidence) => {
    const c = campaign({ inviteNote: "Hi {{first_name}}, we work in {{industry}}." });
    const p = approved(c, {}, { industryEvidence });
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(prospect(kit, p.prospectId).reviewReason).toMatch(/unresolved variable \(industry\)/);
    expect(kit.world.log).toHaveLength(0);
  });

  it("fills {{industry}} from evidence of confidence 0.7 or more with a source", async () => {
    const c = campaign({ inviteNote: "Hi {{first_name}}, we work in {{industry}}." });
    const p = approved(c, {}, { industryEvidence: { value: "Construction", source: "headline", confidence: 0.7 } });
    await kit.engine.tick();
    expect(prospect(kit, p.prospectId).inviteNoteSent).toBe("Hi Test, we work in Construction.");
  });

  it("rejects a person already contacted by another prospect, without loading LinkedIn", async () => {
    const first = campaign();
    const second = campaign();
    const p = approved(first);
    const earlier = addProspect(kit, second, p.personId, { stage: "completed" });
    kit.db.update(people).set({ contactedAt: START, contactedProspectId: earlier }).where(eq(people.id, p.personId)).run();
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("rejected");
    expect(kit.world.log).toHaveLength(0);
    expect(hasEvent("already contacted")).toBe(true);
  });

  it("rejects a person marked do not contact, without loading LinkedIn", async () => {
    const p = approved(campaign(), {}, { doNotContact: true });
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("rejected");
    expect(kit.world.log).toHaveLength(0);
  });

  it("holds for review when another person already has the member id, and sends nothing", async () => {
    const c = campaign();
    const p = approved(c);
    const other = kit.db
      .insert(people)
      .values({ publicId: "test-old-url", profileUrl: "https://www.linkedin.com/in/test-old-url/", fullName: "Test Old", firstSeenAt: START, memberId: p.spec.memberId })
      .returning({ id: people.id })
      .get().id;
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(prospect(kit, p.prospectId).reviewReason).toContain(`same member as person ${other}`);
    expect(kit.world.invitesTo(p.spec.publicId)).toHaveLength(0);
    expect(person(kit, p.personId).contactedAt).toBeNull();
  });

  it.each([
    ["pending", { invitedOutsideApp: true }],
    ["connected", { degree: 1 as const }],
    ["follow only", { connectUnavailable: true }],
  ])("holds for review when the profile shows %s, and sends nothing", async (state, spec) => {
    const p = approved(campaign(), spec);
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(prospect(kit, p.prospectId).reviewReason).toContain(state);
    expect(kit.world.log.filter((entry) => entry.kind === "invite")).toHaveLength(0);
    expect(actionByKey(kit, `invite:${p.prospectId}`)).toBeUndefined();
  });

  it.each(["already_pending", "already_connected", "not_offered"] as const)(
    "a %s refusal fails the row with that kind and holds the prospect for review",
    async (refusal) => {
      kit.close();
      start({ wrap: (driver) => ({ ...driver, sendInvite: () => Promise.resolve(refusal) }) });
      const p = approved(campaign());
      await kit.engine.tick();
      expect(actionByKey(kit, `invite:${p.prospectId}`)).toMatchObject({ status: "failed", errorKind: refusal });
      expect(stage(p.prospectId)).toBe("needs_review");
    },
  );

  it("holds for review a retry whose frozen note is over 200 characters, without loading LinkedIn", async () => {
    // A note frozen by an attempt made while LinkedIn's limit was thought to be 300 (2026-11-13).
    const p = approved(campaign({ inviteNote: "Hi {{first_name}}" }));
    kit.db.insert(actions).values({ type: "invite", status: "planned", idempotencyKey: `invite:${p.prospectId}`, prospectId: p.prospectId, attempts: 1, startedAt: new Date(START.getTime() - HOUR) }).run();
    kit.db.update(prospects).set({ inviteNoteSent: "x".repeat(217) }).where(eq(prospects.id, p.prospectId)).run();
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(prospect(kit, p.prospectId).reviewReason).toMatch(/217 characters/);
    expect(kit.world.log).toHaveLength(0);
  });

  it("never sends a step whose row was already claimed: the claim fails and the prospect is held", async () => {
    const p = approved(campaign());
    kit.db.insert(actions).values({ type: "invite", status: "failed", idempotencyKey: `invite:${p.prospectId}`, prospectId: p.prospectId, attempts: 1, startedAt: new Date(START.getTime() - 24 * HOUR) }).run();
    await kit.engine.tick();
    expect(kit.world.invitesTo(p.spec.publicId)).toHaveLength(0);
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(prospect(kit, p.prospectId).reviewReason).toContain("could not be claimed");
  });
});

describe("connections check", () => {
  it("moves an invited prospect whose person is now a connection to accepted and schedules the first message", async () => {
    const c = campaign({ acceptToMessageMinHours: 24, acceptToMessageMaxHours: 48 });
    const p = invited(c, 2, { acceptsAfterHours: 1 });
    const result = await kit.engine.tick();
    expect(result.did).toContain("connections check: 1 accepted");
    const row = prospect(kit, p.prospectId);
    expect(row.stage).toBe("accepted");
    expect(row.acceptanceObservedAt).not.toBeNull();
    const delay = (row.nextActionAt?.getTime() ?? 0) - (row.acceptanceObservedAt?.getTime() ?? 0);
    expect(delay).toBeGreaterThanOrEqual(24 * HOUR);
    expect(hasEvent(`${p.spec.fullName} accepted the invitation`)).toBe(true);
  });

  it("stores the member id from the card when the person has none", async () => {
    const c = campaign();
    const p = invited(c, 2, { acceptsAfterHours: 1 });
    kit.db.update(people).set({ memberId: null }).where(eq(people.id, p.personId)).run();
    await kit.engine.tick();
    expect(person(kit, p.personId).memberId).toBe(p.spec.memberId);
    expect(stage(p.prospectId)).toBe("accepted");
  });

  it("runs at most once in three hours", async () => {
    const c = campaign();
    invited(c, 2);
    await step(kit);
    const checks = () => actionRows(kit).filter((row) => row.type === "connections_check").length;
    expect(checks()).toBe(1);
    kit.clock.set(new Date(START.getTime() + 2 * HOUR));
    await step(kit);
    expect(checks()).toBe(1);
    kit.clock.set(new Date(START.getTime() + 3 * HOUR + MINUTE));
    await step(kit);
    expect(checks()).toBe(2);
  });

  it("observes an acceptance in a paused campaign but sends it nothing", async () => {
    const c = campaign({ status: "paused" });
    const p = invited(c, 2, { acceptsAfterHours: 1 });
    await step(kit);
    expect(stage(p.prospectId)).toBe("accepted");
    for (let i = 0; i < 5; i++) await step(kit);
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(0);
    expect(stage(p.prospectId)).toBe("accepted");
  });
});

describe("first message", () => {
  it("reads the thread, sends the rendered message once and moves to message_sent with the follow-up scheduled", async () => {
    const c = campaign({ followUpDelayMinHours: 24, followUpDelayMaxHours: 48 });
    const p = accepted(c);
    await kit.engine.tick();
    const row = prospect(kit, p.prospectId);
    expect(row.stage).toBe("message_sent");
    expect(row.firstMessageSent).toBe("Hi Test, thanks for connecting.");
    expect(row.firstMessageSentAt).not.toBeNull();
    expect((row.nextActionAt?.getTime() ?? 0) - (row.firstMessageSentAt?.getTime() ?? 0)).toBeGreaterThanOrEqual(24 * HOUR);
    expect(kit.world.messagesSentTo(p.spec.publicId).map((entry) => entry.text)).toEqual(["Hi Test, thanks for connecting."]);
    expect(actionByKey(kit, `message1:${p.prospectId}`)).toMatchObject({ status: "done", detail: { userMessagesBefore: 0 } });
    expect(actionRows(kit).map((r) => r.type)).toEqual(["thread_check", "message"]);
    expect(hasEvent(`First message sent to ${p.spec.fullName}`)).toBe(true);
  });

  it.each([
    ["no first name", null],
    ["a blank first name", "  "],
  ])("with %s, never falls back to the full name: held for review, nothing sent", async (_label, firstName) => {
    const c = campaign();
    const p = accepted(c, { fullName: "Dott. Testa Person" });
    kit.db.update(people).set({ firstName }).where(eq(people.id, p.personId)).run();
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(prospect(kit, p.prospectId).reviewReason).toContain("first_name");
    expect(prospect(kit, p.prospectId).firstMessageSent).toBeNull();
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(0);
  });

  it("uses the stored first name, trimmed", async () => {
    const c = campaign();
    const p = accepted(c, { fullName: "Dott. Testa Person" });
    kit.db.update(people).set({ firstName: " Testa " }).where(eq(people.id, p.personId)).run();
    await kit.engine.tick();
    expect(prospect(kit, p.prospectId).firstMessageSent).toBe("Hi Testa, thanks for connecting.");
  });

  it("is not stopped by the invite note LinkedIn shows as the first message", async () => {
    const c2 = campaign({ inviteNote: "Hello there: a note" });
    const q = approved(c2, { acceptsAfterHours: 2 });
    await until(() => stage(q.prospectId) === "invited");
    kit.clock.set(new Date(kit.clock.now().getTime() + 3 * HOUR));
    await until(() => stage(q.prospectId) === "message_sent");
    expect(kit.world.messagesSentTo(q.spec.publicId)).toHaveLength(1);
  });

  it("stops the sequence when the person replied first, and sends nothing", async () => {
    const p = accepted(campaign(), { repliesBeforeFirstMessageAfterHours: 0.5 });
    await kit.engine.tick();
    const row = prospect(kit, p.prospectId);
    expect(row).toMatchObject({ stage: "stopped", stopReason: "replied" });
    expect(row.replyDetectedAt).not.toBeNull();
    expect(row.closedAt).not.toBeNull();
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(0);
    expect(hasEvent("replied")).toBe(true);
  });

  it("stops the sequence when the user messaged the person himself, and sends nothing", async () => {
    const p = accepted(campaign(), { userWritesAfterHours: 0.5 });
    await kit.engine.tick();
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "stopped", stopReason: "manual_takeover" });
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(0);
  });

  it("a reply that lands while the message is being typed: nothing is sent, the row goes back to planned, the next tick stops the sequence", async () => {
    kit.close();
    let replied = false;
    start({
      hook: (point) => {
        if (replied || point.op !== "sendMessage" || point.phase !== "typed") return;
        replied = true;
        kit.world.writeAsMember(p.spec.publicId, "A reply written just now", kit.clock.now());
      },
    });
    const p = accepted(campaign());
    await step(kit);
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(0);
    // LinkedIn's own refusal: the claim is given back, so it does not use up one of the 3 attempts.
    expect(actionByKey(kit, `message1:${p.prospectId}`)).toMatchObject({ status: "planned", errorKind: "thread_changed", attempts: 0 });
    expect(stage(p.prospectId)).toBe("accepted");
    await step(kit);
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "stopped", stopReason: "replied" });
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(0);
  });

  it("holds for review when the template cannot be rendered, and sends nothing", async () => {
    const p = accepted(campaign({ firstMessage: "Hi {{first_name}} at {{company}}" }));
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(prospect(kit, p.prospectId).reviewReason).toContain("company");
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(0);
  });

  it("holds for review when the person's member id is not known, without loading LinkedIn", async () => {
    const p = accepted(campaign());
    kit.db.update(people).set({ memberId: null }).where(eq(people.id, p.personId)).run();
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(kit.world.log).toHaveLength(0);
  });

  it("is not sent before its time", async () => {
    const p = accepted(campaign(), {}, { nextActionAt: new Date(START.getTime() + HOUR) });
    expect((await kit.engine.tick()).did).toBeNull();
    kit.clock.set(new Date(START.getTime() + HOUR));
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("message_sent");
  });
});

describe("follow-up", () => {
  async function messaged(spec: Partial<MemberSpec> = {}, values: CampaignValues = {}) {
    const c = campaign({ followUpDelayMinHours: 24, followUpDelayMaxHours: 24, ...values });
    const p = accepted(c, spec);
    await step(kit);
    expect(stage(p.prospectId)).toBe("message_sent");
    const due = prospect(kit, p.prospectId).nextActionAt;
    if (due === null) throw new Error("no follow-up time");
    kit.clock.set(due);
    return p;
  }

  it("checks the thread, sends the follow-up once and completes the sequence", async () => {
    const p = await messaged();
    await kit.engine.tick();
    const row = prospect(kit, p.prospectId);
    expect(row.stage).toBe("completed");
    expect(row.followUpSent).toBe("Hi Test, following up on my last note.");
    expect(row.followUpSentAt).not.toBeNull();
    expect(row.closedAt).not.toBeNull();
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(2);
    expect(actionByKey(kit, `followup:${p.prospectId}`)).toMatchObject({ status: "done", detail: { userMessagesBefore: 1 } });
    expect(hasEvent(`Follow-up sent to ${p.spec.fullName}`)).toBe(true);
  });

  it("stops when the person replied after the first message", async () => {
    const p = await messaged({ repliesAfterHours: 2 });
    await kit.engine.tick();
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "stopped", stopReason: "replied" });
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(1);
  });

  it("stops when the user re-sent the app's message by hand, word for word", async () => {
    const p = await messaged({ userResendsAfterHours: 2 });
    await kit.engine.tick();
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "stopped", stopReason: "manual_takeover" });
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(1);
  });

  describe("when the campaign's follow-up is blank", () => {
    it("reads the thread, then completes with nothing sent", async () => {
      const p = await messaged({}, { followUp: "  " });
      const threadChecks = () => actionRows(kit).filter((row) => row.type === "thread_check").length;
      const checksBefore = threadChecks();
      await kit.engine.tick();
      expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "completed", followUpSentAt: null, followUpSent: null });
      expect(prospect(kit, p.prospectId).closedAt).not.toBeNull();
      expect(threadChecks()).toBe(checksBefore + 1);
      expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(1);
      expect(actionByKey(kit, `followup:${p.prospectId}`)).toBeUndefined();
    });

    it("stops as replied when the person replied after the first message", async () => {
      const p = await messaged({ repliesAfterHours: 2 }, { followUp: "" });
      await kit.engine.tick();
      expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "stopped", stopReason: "replied" });
      expect(prospect(kit, p.prospectId).replyDetectedAt).not.toBeNull();
      expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(1);
    });

    it("stops as manual takeover when the user wrote to the person himself", async () => {
      const p = await messaged({ userWritesAfterHours: 2 }, { followUp: "" });
      await kit.engine.tick();
      expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "stopped", stopReason: "manual_takeover" });
      expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(1);
    });
  });
});

describe("the working window, checked again right before a claim", () => {
  /** Monday 17:54 in Rome: inside the window and outside its last five minutes. */
  const LATE = new Date("2026-11-16T16:54:00Z");
  const NEXT_MORNING = new Date("2026-11-17T08:00:00Z");
  /** The read starts at 17:54 and returns at 19:00: the laptop slept while the page loaded. */
  const SLEPT = 66 * MINUTE;

  const STEPS = [
    {
      step: "invite",
      done: "invited",
      seed: () => approved(campaign()),
      read: "viewProfile",
    },
    {
      step: "message1",
      done: "message_sent",
      seed: () => accepted(campaign(), {}, { nextActionAt: LATE }),
      read: "readThread",
    },
    {
      step: "followup",
      done: "completed",
      seed: async () => {
        const p = accepted(campaign());
        await step(kit);
        expect(stage(p.prospectId)).toBe("message_sent");
        return p;
      },
      read: "readThread",
    },
    {
      step: "withdraw",
      done: "withdrawn",
      seed: () => invited(campaign(), 22),
      read: "viewProfile",
    },
  ] as const;

  it.each([
    { step: "invite", read: "viewProfile", lower: { limits: { invitesPerDay: 0 } }, seed: () => approved(campaign()) },
    { step: "message1", read: "readThread", lower: { limits: { messagesPerDay: 0 } }, seed: () => accepted(campaign()) },
  ] as const)("$step: the user lowers the day's budget to 0 during the read: no claim, the prospect untouched", async ({ step: name, read, lower, seed }) => {
    kit.close();
    let fired = false;
    start({
      hook: (point) => {
        if (fired || point.op !== read || point.phase !== "after") return;
        fired = true;
        kit.settings(lower);
      },
    });
    kit.settings({ warmUp: { enabled: false } });
    const p = seed();
    const before = prospect(kit, p.prospectId);
    await kit.engine.tick();
    expect(fired).toBe(true);
    expect(actionByKey(kit, `${name}:${p.prospectId}`)).toBeUndefined();
    expect(prospect(kit, p.prospectId)).toEqual(before);
    expect(kit.world.log.filter((entry) => entry.kind === "invite" || entry.kind === "message")).toHaveLength(0);
  });

  it("followup: a follow-up that became due on the day the budget was spent during its read is not claimed", async () => {
    kit.close();
    let armed = false;
    start({
      hook: (point) => {
        if (!armed || point.op !== "readThread" || point.phase !== "after") return;
        armed = false;
        kit.settings({ limits: { messagesPerDay: 1 } });
      },
    });
    const p = accepted(campaign());
    await step(kit);
    expect(stage(p.prospectId)).toBe("message_sent");
    armed = true;
    await step(kit);
    expect(actionByKey(kit, `followup:${p.prospectId}`)).toBeUndefined();
    expect(stage(p.prospectId)).toBe("message_sent");
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(1);
  });

  it.each(STEPS)("$step: a read that returns inside the last 5 minutes of the window (17:56) claims nothing; the next window sends", async ({ step: name, done, seed, read }) => {
    const p = await seed();
    kit.clock.set(LATE);
    connectionsJustChecked();
    const stageBefore = stage(p.prospectId);
    kit.world.suspendNext(read, 2 * MINUTE);
    await step(kit);
    expect(actionByKey(kit, `${name}:${p.prospectId}`)).toBeUndefined();
    expect(stage(p.prospectId)).toBe(stageBefore);
    const writes = () => kit.world.log.filter((entry) => entry.kind === "invite" || entry.kind === "withdraw" || entry.kind === "message");
    const writesBefore = writes().length;
    await until(() => stage(p.prospectId) === done);
    expect(writes()).toHaveLength(writesBefore + 1);
    expect(writes().at(-1)?.at.getTime()).toBeGreaterThanOrEqual(NEXT_MORNING.getTime());
  });

  it.each([
    {
      step: "invite",
      done: "invited",
      seed: () => approved(campaign()),
      read: "viewProfile",
    },
    {
      step: "message1",
      done: "message_sent",
      seed: () => accepted(campaign(), {}, { nextActionAt: LATE }),
      read: "readThread",
    },
    {
      step: "followup",
      done: "completed",
      seed: async () => {
        const p = accepted(campaign());
        await step(kit);
        expect(stage(p.prospectId)).toBe("message_sent");
        return p;
      },
      read: "readThread",
    },
    {
      step: "withdraw",
      done: "withdrawn",
      seed: () => invited(campaign(), 22),
      read: "viewProfile",
    },
  ] as const)("$step: a read that returns after the window closed claims nothing and moves nothing; the next window starts over", async ({ step: name, done, seed, read }) => {
    const p = await seed();
    kit.clock.set(LATE);
    connectionsJustChecked();
    const stageBefore = stage(p.prospectId);
    kit.world.suspendNext(read, SLEPT);
    await step(kit);
    expect(kit.clock.now().getTime()).toBeGreaterThanOrEqual(LATE.getTime() + SLEPT);
    expect(actionByKey(kit, `${name}:${p.prospectId}`)).toBeUndefined();
    expect(stage(p.prospectId)).toBe(stageBefore);
    const writes = () => kit.world.log.filter((entry) => entry.kind === "invite" || entry.kind === "withdraw" || entry.kind === "message");
    const writesBefore = writes().length;

    await until(() => stage(p.prospectId) === done);
    expect(writes()).toHaveLength(writesBefore + 1);
    expect(writes().at(-1)?.at.getTime()).toBeGreaterThanOrEqual(NEXT_MORNING.getTime());
  });
});

describe("a write the laptop sleeps through (SendGuard)", () => {
  /** Monday 17:50 in Rome. */
  const LATE = new Date("2026-11-16T16:50:00Z");
  const WINDOW_END = new Date("2026-11-16T17:00:00Z");
  const NEXT_MORNING = new Date("2026-11-17T08:00:00Z");
  /** The send starts before 18:00 and its click would come at 07:00 the next day. */
  const SLEPT = 14 * 60 * MINUTE;

  it.each([
    { step: "invite", op: "sendInvite", done: "invited", seed: () => approved(campaign()) },
    { step: "message1", op: "sendMessage", done: "message_sent", seed: () => accepted(campaign(), {}, { nextActionAt: LATE }) },
    { step: "withdraw", op: "withdrawInvite", done: "withdrawn", seed: () => invited(campaign(), 22) },
  ] as const)("$step: the driver gets the window's end as notAfter; expired puts the row back to planned, the prospect unmoved, and the next window sends", async ({ step: name, op, done, seed }) => {
    const p = seed();
    kit.clock.set(LATE);
    connectionsJustChecked();
    const stageBefore = stage(p.prospectId);
    kit.world.suspendNext(op, SLEPT);
    await step(kit);
    expect(actionByKey(kit, `${name}:${p.prospectId}`)).toMatchObject({ status: "planned", errorKind: "expired" });
    expect(stage(p.prospectId)).toBe(stageBefore);
    const writes = () => kit.world.log.filter((entry) => entry.kind === "invite" || entry.kind === "withdraw" || entry.kind === "message");
    expect(writes()).toHaveLength(0);
    expect(hasEvent("working window closed")).toBe(true);

    await until(() => stage(p.prospectId) === done);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.at.getTime()).toBeGreaterThanOrEqual(NEXT_MORNING.getTime());
  });

  it(`expiries do not use up the step's ${3} attempts: four evenings in a row expire, the fifth morning sends`, async () => {
    const p = accepted(campaign(), {}, { nextActionAt: LATE });
    for (let day = 0; day < 4; day++) {
      kit.clock.set(new Date(LATE.getTime() + day * 24 * HOUR));
      connectionsJustChecked();
      kit.world.suspendNext("sendMessage", SLEPT);
      await step(kit);
      expect(actionByKey(kit, `message1:${p.prospectId}`)).toMatchObject({ status: "planned", errorKind: "expired", attempts: 0 });
      expect(stage(p.prospectId)).toBe("accepted");
    }
    await until(() => stage(p.prospectId) !== "accepted");
    expect(stage(p.prospectId)).toBe("message_sent");
    expect(actionByKey(kit, `message1:${p.prospectId}`)).toMatchObject({ status: "done", attempts: 1 });
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(1);
  });

  it("the deadline passed to the driver is the last instant inside the current working window, from the settings read at claim time", async () => {
    const guards: Date[] = [];
    kit.close();
    start({
      wrap: (driver) => ({
        ...driver,
        sendMessage: (person, text, expected) => {
          guards.push(expected.notAfter);
          return driver.sendMessage(person, text, expected);
        },
      }),
    });
    accepted(campaign(), {}, { nextActionAt: LATE });
    kit.clock.set(LATE);
    await step(kit);
    // The window's end is exclusive and the driver's deadline inclusive: at 18:00:00.000 exactly nothing may go out.
    expect(guards).toEqual([new Date(WINDOW_END.getTime() - 1)]);
    const lastAllowed = guards[0];
    expect(lastAllowed !== undefined && isInWorkingWindow(getSettings(kit.db), lastAllowed)).toBe(true);
    expect(isInWorkingWindow(getSettings(kit.db), WINDOW_END)).toBe(false);
  });
});

describe("a change the user makes while the app works on the prospect", () => {
  /** Restarts the kit with a hook that runs `change` once, when the call reaches `op`/`phase`. */
  function changeDuring(op: DriverOp, phase: KillPhase, change: () => void) {
    kit.close();
    let done = false;
    start({
      hook: (point) => {
        if (done || point.op !== op || point.phase !== phase) return;
        done = true;
        change();
      },
    });
  }
  const setStage = (id: number, to: ProspectStage) => kit.db.update(prospects).set({ stage: to }).where(eq(prospects.id, id)).run();
  const warnings = () => kit.db.select().from(eventLog).where(eq(eventLog.level, "warning")).all().map((row) => row.message);

  it("pause during a thread read: no claim, no needs review, a log line, the prospect left as it was", async () => {
    let c = 0;
    changeDuring("readThread", "after", () => kit.db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, c)).run());
    c = campaign();
    const p = accepted(c);
    await expect(kit.engine.tick()).resolves.toMatchObject({ did: expect.stringContaining("campaign_not_running") });
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "accepted", reviewReason: null });
    expect(actionByKey(kit, `message1:${p.prospectId}`)).toBeUndefined();
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(0);
    expect(hasEvent(`First message to ${p.spec.fullName} not sent: the campaign is now paused`)).toBe(true);
    expect(warnings()).toEqual([]);
  });

  it("the user clears the follow-up text while its thread loads: completed, nothing sent", async () => {
    let c = 0;
    let armed = false;
    kit.close();
    start({
      hook: (point) => {
        if (!armed || point.op !== "readThread" || point.phase !== "after") return;
        armed = false;
        kit.db.update(campaigns).set({ followUp: "" }).where(eq(campaigns.id, c)).run();
      },
    });
    c = campaign();
    const p = accepted(c);
    await step(kit);
    expect(stage(p.prospectId)).toBe("message_sent");
    armed = true;
    await step(kit);
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "completed", followUpSent: null, followUpSentAt: null });
    expect(actionByKey(kit, `followup:${p.prospectId}`)).toBeUndefined();
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(1);
  });

  it("the user edits the first-message template and the first name while the thread loads: the new ones are rendered", async () => {
    let c = 0;
    let personId = 0;
    changeDuring("readThread", "after", () => {
      kit.db.update(campaigns).set({ firstMessage: "Hello {{first_name}}, a new text." }).where(eq(campaigns.id, c)).run();
      kit.db.update(people).set({ firstName: "Newname" }).where(eq(people.id, personId)).run();
    });
    c = campaign();
    const p = accepted(c);
    personId = p.personId;
    await kit.engine.tick();
    expect(kit.world.messagesSentTo(p.spec.publicId).map((entry) => entry.text)).toEqual(["Hello Newname, a new text."]);
    expect(prospect(kit, p.prospectId).firstMessageSent).toBe("Hello Newname, a new text.");
  });

  it("the user edits the invite note while the profile loads: the new note is sent", async () => {
    let c = 0;
    changeDuring("viewProfile", "after", () => kit.db.update(campaigns).set({ inviteNote: "A new note, {{first_name}}." }).where(eq(campaigns.id, c)).run());
    c = campaign({ inviteNote: "The old note, {{first_name}}." });
    const p = approved(c);
    await kit.engine.tick();
    expect(kit.world.invitesTo(p.spec.publicId)).toEqual([expect.objectContaining({ note: "A new note, Test." })]);
  });

  it("the user removes the invite note while the profile loads: the invite goes without one", async () => {
    let c = 0;
    changeDuring("viewProfile", "after", () => kit.db.update(campaigns).set({ inviteNote: null }).where(eq(campaigns.id, c)).run());
    c = campaign({ inviteNote: "The old note, {{first_name}}." });
    const p = approved(c);
    await kit.engine.tick();
    expect(kit.world.invitesTo(p.spec.publicId)).toEqual([expect.not.objectContaining({ note: expect.anything() })]);
  });

  it("a text frozen by an earlier claim still wins over a template edited during the read", async () => {
    let c = 0;
    let armed = false;
    kit.close();
    start({
      hook: (point) => {
        if (!armed || point.op !== "readThread" || point.phase !== "after") return;
        armed = false;
        kit.db.update(campaigns).set({ firstMessage: "A text that must not go: {{first_name}}" }).where(eq(campaigns.id, c)).run();
      },
    });
    c = campaign();
    const p = accepted(c);
    kit.world.failNext("sendMessage", "timeout_before_effect");
    await step(kit);
    await step(kit);
    expect(actionByKey(kit, `message1:${p.prospectId}`)?.status).toBe("planned");
    armed = true;
    await until(() => stage(p.prospectId) === "message_sent");
    expect(kit.world.messagesSentTo(p.spec.publicId).map((entry) => entry.text)).toEqual(["Hi Test, thanks for connecting."]);
  });

  it.each([
    ["the profile shows Connect", {}],
    ["the profile shows pending", { invitedOutsideApp: true }],
  ])("reject during a profile view (%s): the tick resolves, nothing is sent, the prospect stays rejected", async (_label, spec) => {
    let id = 0;
    changeDuring("viewProfile", "after", () => setStage(id, "rejected"));
    const p = approved(campaign(), spec);
    id = p.prospectId;
    await expect(kit.engine.tick()).resolves.toMatchObject({ did: expect.any(String) });
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "rejected", reviewReason: null });
    expect(kit.world.invitesTo(p.spec.publicId)).toHaveLength(0);
    expect(actionByKey(kit, `invite:${p.prospectId}`)).toBeUndefined();
    expect(events(kit).some((message) => message.startsWith(p.spec.fullName) && message.includes("changed while the app was working on it"))).toBe(true);
  });

  it("stop during a send that succeeds: the row is done, the stage stays as the user set it, with a warning", async () => {
    let id = 0;
    changeDuring("sendMessage", "typed", () => setStage(id, "stopped"));
    const p = accepted(campaign());
    id = p.prospectId;
    await expect(kit.engine.tick()).resolves.toMatchObject({ did: expect.any(String) });
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(1);
    expect(actionByKey(kit, `message1:${p.prospectId}`)?.status).toBe("done");
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "stopped", firstMessageSentAt: null });
    expect(warnings()).toEqual([expect.stringMatching(new RegExp(`^${p.spec.fullName} was changed while the app was working on it; left as it is.*First message sent`))]);
    for (let i = 0; i < 5; i++) await step(kit);
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(1);
  });
});

describe("withdraw", () => {
  it("withdraws an invitation older than withdrawAfterDays", async () => {
    const c = campaign();
    const p = invited(c, 22);
    connectionsJustChecked();
    await kit.engine.tick();
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "withdrawn" });
    expect(kit.world.status(p.spec.publicId).pendingSince).toBeNull();
    expect(actionByKey(kit, `withdraw:${p.prospectId}`)?.status).toBe("done");
    expect(hasEvent(`Invitation to ${p.spec.fullName} withdrawn`)).toBe(true);
  });

  it("leaves a younger invitation alone", async () => {
    const c = campaign();
    const p = invited(c, 20);
    connectionsJustChecked();
    expect((await kit.engine.tick()).did).toBeNull();
    expect(stage(p.prospectId)).toBe("invited");
  });

  it("finds a missed acceptance and moves the prospect to accepted instead (decision 33)", async () => {
    const c = campaign();
    const p = invited(c, 30, { acceptsAfterHours: 24 });
    connectionsJustChecked();
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("accepted");
    expect(kit.world.log.filter((entry) => entry.kind === "withdraw")).toHaveLength(0);
  });

  it("closes as withdrawn, with a log line, when there is no invitation left to withdraw", async () => {
    const c = campaign();
    const p = invited(c, 22);
    await kit.world.connect({ clock: kit.clock, random: kit.random }).driver.withdrawInvite({ publicId: p.spec.publicId, memberId: p.spec.memberId }, { notAfter: new Date(START.getTime() + HOUR) });
    connectionsJustChecked();
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("withdrawn");
    expect(hasEvent("nothing was left to withdraw")).toBe(true);
    expect(actionByKey(kit, `withdraw:${p.prospectId}`)).toBeUndefined();
  });

  describe("with the withdrawal budget closed (withdrawalsPerDay 0)", () => {
    beforeEach(() => kit.settings({ limits: { withdrawalsPerDay: 0 } }));

    it("still views the profile, and finds a missed acceptance: accepted, observed today", async () => {
      const p = invited(campaign(), 30, { acceptsAfterHours: 24 });
      connectionsJustChecked();
      await kit.engine.tick();
      expect(stage(p.prospectId)).toBe("accepted");
      expect(prospect(kit, p.prospectId).acceptanceObservedAt?.getTime()).toBeGreaterThanOrEqual(START.getTime());
      expect(kit.world.log.filter((entry) => entry.kind === "withdraw")).toHaveLength(0);
    });

    it("an invitation still pending stays invited, with no claim, until the budget opens again", async () => {
      const p = invited(campaign(), 22);
      connectionsJustChecked();
      await kit.engine.tick();
      expect(stage(p.prospectId)).toBe("invited");
      expect(actionByKey(kit, `withdraw:${p.prospectId}`)).toBeUndefined();
      // Tuesday 09:00 in Rome: the next working instant of the next calendar day.
      expect(prospect(kit, p.prospectId).nextActionAt).toEqual(new Date("2026-11-17T08:00:00Z"));
      const views = () => kit.world.log.filter((entry) => entry.kind === "profile_view").length;
      const viewsBefore = views();
      for (let i = 0; i < 5; i++) await step(kit);
      expect(views()).toBe(viewsBefore);
    });
  });

  it("holds for review when LinkedIn says there is nothing pending to withdraw", async () => {
    kit.close();
    start({ wrap: (driver) => ({ ...driver, withdrawInvite: () => Promise.resolve("not_pending" as const) }) });
    const p = invited(campaign(), 22);
    connectionsJustChecked();
    await kit.engine.tick();
    expect(stage(p.prospectId)).toBe("needs_review");
    expect(actionByKey(kit, `withdraw:${p.prospectId}`)).toMatchObject({ status: "failed", errorKind: "not_pending" });
  });
});
