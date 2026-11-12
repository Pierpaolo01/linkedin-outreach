import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actions, campaigns, eventLog, prospects } from "../db/schema";
import {
  approvalQueue,
  approveAll,
  approveProspect,
  listProspects,
  rejectProspect,
  resolveReview,
  reviewQueue,
  setDoNotContact,
} from "./prospects";
import { openTestDb, seedCampaign, seedPerson, seedPersonProspect, seedProspect, T0, type TestDb } from "./testSeed";
import {
  actionByKey,
  createKit,
  prospect as engineProspect,
  runUntil,
  seedAccepted,
  seedCampaign as engineCampaign,
  step,
  type Kit,
} from "../engine/testKit";

const LATER = new Date(T0.getTime() + 60_000);
const ALL = { page: 1, pageSize: 50 };

let t: TestDb;
beforeEach(() => {
  t = openTestDb();
});
afterEach(() => t.close());

function prospect(id: number) {
  const row = t.db.select().from(prospects).where(eq(prospects.id, id)).get();
  if (row === undefined) throw new Error(`no prospect ${id}`);
  return row;
}
const campaignStatus = (id: number) => t.db.select({ s: campaigns.status }).from(campaigns).where(eq(campaigns.id, id)).get()?.s;
const messages = () => t.db.select().from(eventLog).all().map((e) => e.message);

describe("listProspects", () => {
  it("lists a campaign's prospects with the person, score, stage and texts as sent", () => {
    const id = seedCampaign(t.db, { status: "running" });
    const { prospectId, personId } = seedPersonProspect(t.db, id, 1, "message_sent", {
      inviteNoteSent: "Hi Test",
      firstMessageSent: "Thanks Test",
      nextActionAt: LATER,
    });

    const page = listProspects(t.db, id, { stage: null, ...ALL });

    expect(page).toMatchObject({
      ok: true,
      value: {
        page: 1,
        pageSize: 50,
        total: 1,
        items: [
          {
            id: prospectId,
            campaignId: id,
            campaignName: "Test campaign",
            stage: "message_sent",
            score: 8,
            scoreReason: "Owns a small manufacturer",
            reviewReason: null,
            nextActionAt: LATER,
            texts: { inviteNote: "Hi Test", firstMessage: "Thanks Test", followUp: null },
            person: {
              id: personId,
              fullName: "Test Person 1",
              title: "Founder",
              company: "Example Company 1",
              profileUrl: "https://www.linkedin.com/in/test-person-1/",
              doNotContact: false,
            },
          },
        ],
      },
    });
  });

  it("filters by stage and pages", () => {
    const id = seedCampaign(t.db);
    for (let n = 1; n <= 5; n += 1) seedPersonProspect(t.db, id, n, n <= 3 ? "pending_approval" : "rejected");

    const result = listProspects(t.db, id, { stage: "pending_approval", page: 2, pageSize: 2 });

    expect(result.ok && { total: result.value.total, names: result.value.items.map((p) => p.person.fullName) }).toEqual({
      total: 3,
      names: ["Test Person 3"],
    });
  });

  it("answers not found for an unknown campaign", () => {
    expect(listProspects(t.db, 99, { stage: null, ...ALL })).toEqual({ ok: false, kind: "not_found", message: "No campaign 99" });
  });
});

describe("approvalQueue", () => {
  it("lists prospects waiting for approval, best score first, with evidence and a preview of the note and first message", () => {
    const id = seedCampaign(t.db, { status: "awaiting_approval" });
    const personId = seedPerson(t.db, 1, { industryEvidence: { value: "Machinery", source: "profile", confidence: 0.8 } });
    seedProspect(t.db, id, personId, "pending_approval", { score: 7 });
    seedPersonProspect(t.db, id, 2, "pending_approval", { score: 9 });
    seedPersonProspect(t.db, id, 3, "approved", { score: 10 });

    const result = approvalQueue(t.db, { campaignId: null, minScore: null, ...ALL });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((p) => [p.person.fullName, p.score])).toEqual([
      ["Test Person 2", 9],
      ["Test Person 1", 7],
    ]);
    expect(result.value.items[1]).toMatchObject({
      person: { industryEvidence: { value: "Machinery", source: "profile", confidence: 0.8 } },
      preview: {
        inviteNote: { ok: true, text: "Hi Test, I work with companies like Example Company 1." },
        firstMessage: { ok: true, text: "Thanks for connecting, Test." },
      },
    });
  });

  it("previews the follow-up as the engine would write it, and null for a campaign without one", () => {
    const withFollowUp = seedCampaign(t.db, { status: "awaiting_approval", followUp: "Any thoughts, {{first_name}}? {{title}}" });
    const without = seedCampaign(t.db, { status: "awaiting_approval", followUp: "  " });
    const unresolved = seedCampaign(t.db, { status: "awaiting_approval", followUp: "Hi {{first_name}}" });
    seedPersonProspect(t.db, withFollowUp, 1, "pending_approval", { score: 9 });
    seedPersonProspect(t.db, without, 2, "pending_approval", { score: 8 });
    seedProspect(t.db, unresolved, seedPerson(t.db, 3, { firstName: null }), "pending_approval", { score: 7 });

    const result = approvalQueue(t.db, { campaignId: null, minScore: null, ...ALL });

    expect(result.ok && result.value.items.map((item) => item.followUpPreview)).toEqual([
      { ok: true, text: "Any thoughts, Test? Founder", length: 27 },
      null,
      { ok: false, problem: "unresolved_variable", variables: ["first_name"], message: "No value for {{first_name}} for this person" },
    ]);
  });

  it("shows the AI line and the profile text it rests on", () => {
    const id = seedCampaign(t.db, { status: "awaiting_approval", aiPersonalise: true, firstMessage: "Hi {{first_name}}. {{ai_line}}" });
    seedPersonProspect(t.db, id, 1, "pending_approval", { aiLine: "Your plant in Monza stands out.", aiLineEvidence: "Plant manager in Monza" });

    const result = approvalQueue(t.db, { campaignId: null, minScore: null, ...ALL });

    expect(result.ok && result.value.items[0]).toMatchObject({
      aiLineEvidence: "Plant manager in Monza",
      preview: { firstMessage: { ok: true, text: "Hi Test. Your plant in Monza stands out." } },
    });
  });

  it("previews what the engine would send when the AI wrote no line: nothing, the text cannot be written", () => {
    const id = seedCampaign(t.db, { status: "awaiting_approval", aiPersonalise: true, firstMessage: "Hi {{first_name}}. {{ai_line}}" });
    seedPersonProspect(t.db, id, 1, "pending_approval", { aiLine: null });

    const result = approvalQueue(t.db, { campaignId: null, minScore: null, ...ALL });

    expect(result.ok && result.value.items[0]).toMatchObject({
      aiLineEvidence: null,
      preview: { firstMessage: { ok: false, problem: "unresolved_variable", variables: ["ai_line"] } },
    });
  });

  it("filters by campaign and minimum score", () => {
    const a = seedCampaign(t.db);
    const b = seedCampaign(t.db);
    seedPersonProspect(t.db, a, 1, "pending_approval", { score: 6 });
    seedPersonProspect(t.db, a, 2, "pending_approval", { score: 8 });
    seedPersonProspect(t.db, b, 3, "pending_approval", { score: 9 });

    const result = approvalQueue(t.db, { campaignId: a, minScore: 7, ...ALL });

    expect(result.ok && result.value.items.map((p) => p.person.fullName)).toEqual(["Test Person 2"]);
  });

  it("answers not found for an unknown campaign", () => {
    expect(approvalQueue(t.db, { campaignId: 99, minScore: null, ...ALL })).toMatchObject({ ok: false, kind: "not_found" });
  });
});

describe("approveProspect", () => {
  it("approves, stamps approvedAt, and moves a campaign awaiting approval to running", () => {
    const id = seedCampaign(t.db, { status: "awaiting_approval" });
    const { prospectId } = seedPersonProspect(t.db, id, 1, "pending_approval");

    expect(approveProspect(t.db, prospectId, LATER)).toMatchObject({ ok: true, value: { stage: "approved", approvedAt: LATER } });
    expect(campaignStatus(id)).toBe("running");
    expect(messages()).toEqual(["Approved Test Person 1", 'Campaign "Test campaign" running: a prospect was approved']);
  });

  it("leaves a paused campaign paused", () => {
    const id = seedCampaign(t.db, { status: "paused" });
    const { prospectId } = seedPersonProspect(t.db, id, 1, "pending_approval");

    approveProspect(t.db, prospectId, LATER);

    expect(campaignStatus(id)).toBe("paused");
  });

  it("refuses a prospect that is not waiting for approval", () => {
    const id = seedCampaign(t.db);
    const { prospectId } = seedPersonProspect(t.db, id, 1, "invited");

    expect(approveProspect(t.db, prospectId, LATER)).toEqual({
      ok: false,
      kind: "conflict",
      message: "Only a prospect waiting for approval can be approved; this one is invited",
    });
  });

  it("answers not found for an unknown id", () => {
    expect(approveProspect(t.db, 99, LATER)).toEqual({ ok: false, kind: "not_found", message: "No prospect 99" });
  });
});

describe("rejectProspect", () => {
  it("rejects and closes a prospect waiting for approval", () => {
    const id = seedCampaign(t.db);
    const { prospectId } = seedPersonProspect(t.db, id, 1, "pending_approval");

    expect(rejectProspect(t.db, prospectId, LATER)).toMatchObject({ ok: true, value: { stage: "rejected", closedAt: LATER } });
  });

  it("refuses a prospect that is not waiting for approval", () => {
    const id = seedCampaign(t.db);
    const { prospectId } = seedPersonProspect(t.db, id, 1, "completed");

    expect(rejectProspect(t.db, prospectId, LATER)).toMatchObject({ ok: false, kind: "conflict" });
  });
});

describe("approveAll", () => {
  it("approves every waiting prospect of the campaign at or above the minimum score", () => {
    const id = seedCampaign(t.db, { status: "awaiting_approval" });
    const low = seedPersonProspect(t.db, id, 1, "pending_approval", { score: 6 }).prospectId;
    const high = seedPersonProspect(t.db, id, 2, "pending_approval", { score: 7 }).prospectId;
    const other = seedPersonProspect(t.db, seedCampaign(t.db), 3, "pending_approval", { score: 9 }).prospectId;

    expect(approveAll(t.db, { campaignId: id, minScore: 7 }, LATER)).toEqual({ ok: true, value: { approved: 1, campaignStatus: "running" } });
    expect([prospect(low).stage, prospect(high).stage, prospect(other).stage]).toEqual(["pending_approval", "approved", "pending_approval"]);
  });

  it("approves everyone waiting without a minimum score", () => {
    const id = seedCampaign(t.db, { status: "awaiting_approval" });
    seedPersonProspect(t.db, id, 1, "pending_approval", { score: 2 });
    seedPersonProspect(t.db, id, 2, "pending_approval", { score: null });

    expect(approveAll(t.db, { campaignId: id, minScore: null }, LATER)).toEqual({ ok: true, value: { approved: 2, campaignStatus: "running" } });
  });

  it("changes nothing when nobody qualifies", () => {
    const id = seedCampaign(t.db, { status: "awaiting_approval" });
    seedPersonProspect(t.db, id, 1, "pending_approval", { score: 2 });

    expect(approveAll(t.db, { campaignId: id, minScore: 9 }, LATER)).toEqual({ ok: true, value: { approved: 0, campaignStatus: "awaiting_approval" } });
  });

  it("answers not found for an unknown campaign", () => {
    expect(approveAll(t.db, { campaignId: 99, minScore: null }, LATER)).toMatchObject({ ok: false, kind: "not_found" });
  });
});

describe("reviewQueue", () => {
  it("lists prospects held for review with the reason and the newest screenshot", () => {
    const id = seedCampaign(t.db, { status: "running" });
    const { prospectId } = seedPersonProspect(t.db, id, 1, "needs_review", { reviewReason: "already connected" });
    seedPersonProspect(t.db, id, 2, "invited");
    t.db.insert(actions).values({ type: "invite", prospectId, campaignId: id, status: "unknown", idempotencyKey: `invite:${prospectId}`, screenshotPath: "/shots/1.png" }).run();

    const result = reviewQueue(t.db, { campaignId: null, ...ALL });

    expect(result).toMatchObject({
      ok: true,
      value: { total: 1, items: [{ id: prospectId, reviewReason: "already connected", screenshotPath: "/shots/1.png", person: { fullName: "Test Person 1" } }] },
    });
  });

  it("gives the screenshot's address in the app, or null without a screenshot or with a name the app does not serve", () => {
    const id = seedCampaign(t.db, { status: "running" });
    const shot = seedPersonProspect(t.db, id, 1, "needs_review").prospectId;
    const none = seedPersonProspect(t.db, id, 2, "needs_review").prospectId;
    const odd = seedPersonProspect(t.db, id, 3, "needs_review").prospectId;
    const row = (prospectId: number, screenshotPath: string) => ({ type: "invite" as const, prospectId, campaignId: id, status: "unknown" as const, idempotencyKey: `invite:${prospectId}`, screenshotPath });
    t.db.insert(actions).values(row(shot, "/data/screenshots/2026-11-16T09-00-00-000Z-invite.png")).run();
    t.db.insert(actions).values(row(odd, "/data/screenshots/a shot.png")).run();

    const result = reviewQueue(t.db, { campaignId: null, ...ALL });

    expect(result.ok && result.value.items.map((item) => [item.id, item.screenshotUrl])).toEqual([
      [shot, "/api/screenshots/2026-11-16T09-00-00-000Z-invite.png"],
      [none, null],
      [odd, null],
    ]);
  });
});

describe("resolveReview", () => {
  it("sends a prospect back to the stage it should continue from, due now, with the note logged", () => {
    const id = seedCampaign(t.db, { status: "running" });
    const { prospectId } = seedPersonProspect(t.db, id, 1, "needs_review", { reviewReason: "unknown send result" });

    const result = resolveReview(t.db, prospectId, { stage: "accepted", note: "Checked: we are connected" }, LATER);

    expect(result).toMatchObject({ ok: true, value: { stage: "accepted", reviewReason: null, nextActionAt: LATER } });
    expect(messages()).toEqual(["Test Person 1 resolved by the user: now accepted. Note: Checked: we are connected"]);
  });

  it("stamps approvedAt when the user approves a prospect held for review, so the engine may invite it", () => {
    const id = seedCampaign(t.db, { status: "running" });
    const { prospectId } = seedPersonProspect(t.db, id, 1, "needs_review", { reviewReason: "unclear profile", approvedAt: null });

    expect(resolveReview(t.db, prospectId, { stage: "approved", note: null }, LATER)).toMatchObject({ ok: true, value: { stage: "approved", approvedAt: LATER, nextActionAt: LATER } });
  });

  it("keeps the first approval time of a prospect approved before it was held", () => {
    const id = seedCampaign(t.db, { status: "running" });
    const { prospectId } = seedPersonProspect(t.db, id, 1, "needs_review", { approvedAt: T0 });

    expect(resolveReview(t.db, prospectId, { stage: "approved", note: null }, LATER)).toMatchObject({ ok: true, value: { approvedAt: T0 } });
  });

  it.each(["rejected", "stopped"] as const)("closes a prospect resolved as %s", (stage) => {
    const id = seedCampaign(t.db);
    const { prospectId } = seedPersonProspect(t.db, id, 1, "needs_review");

    expect(resolveReview(t.db, prospectId, { stage, note: null }, LATER)).toMatchObject({ ok: true, value: { stage, closedAt: LATER, nextActionAt: null } });
  });

  it("refuses a stage the lifecycle does not allow from needs review", () => {
    const id = seedCampaign(t.db);
    const { prospectId } = seedPersonProspect(t.db, id, 1, "needs_review");

    expect(resolveReview(t.db, prospectId, { stage: "completed", note: null }, LATER)).toEqual({
      ok: false,
      kind: "conflict",
      message: "A prospect in needs review cannot move to completed. Choose rejected, stopped, approved, invited, accepted or message_sent",
    });
  });

  it("refuses a prospect that is not in needs review", () => {
    const id = seedCampaign(t.db);
    const { prospectId } = seedPersonProspect(t.db, id, 1, "invited");

    expect(resolveReview(t.db, prospectId, { stage: "rejected", note: null }, LATER)).toEqual({
      ok: false,
      kind: "conflict",
      message: "Only a prospect in needs review can be resolved; this one is invited",
    });
  });

  describe("the ledger row of the step it continues from", () => {
    const STARTED = new Date(T0.getTime() - 3_600_000);
    const held = (values: Partial<typeof prospects.$inferInsert> = {}) =>
      seedPersonProspect(t.db, seedCampaign(t.db, { status: "running" }), 1, "needs_review", { approvedAt: T0, ...values }).prospectId;
    function stepRow(prospectId: number, step: string, status: (typeof actions.$inferInsert)["status"], values: Partial<typeof actions.$inferInsert> = {}) {
      t.db
        .insert(actions)
        .values({ type: step === "invite" ? "invite" : step === "withdraw" ? "withdraw" : "message", prospectId, status, idempotencyKey: `${step}:${prospectId}`, startedAt: STARTED, ...values })
        .run();
    }
    const row = (key: string) => t.db.select().from(actions).where(eq(actions.idempotencyKey, key)).get();
    const UNKNOWN = "The app could not tell whether this was sent. Check LinkedIn: if it was sent, continue from the next step; if not, stop the sequence.";

    it.each([
      ["approved", "invite"],
      ["accepted", "message1"],
      ["message_sent", "followup"],
      ["invited", "withdraw"],
    ] as const)("resolved to %s, puts a %s row known not sent back to planned with no attempts and no error", (stage, step) => {
      const prospectId = held();
      stepRow(prospectId, step, "planned", { attempts: 3, error: "timed out", errorKind: "timeout_before_effect", finishedAt: T0 });

      expect(resolveReview(t.db, prospectId, { stage, note: null }, LATER)).toMatchObject({ ok: true, value: { stage } });
      expect(row(`${step}:${prospectId}`)).toMatchObject({ status: "planned", attempts: 0, error: null, errorKind: null });
    });

    it("puts a failed row back to planned the same way", () => {
      const prospectId = held();
      stepRow(prospectId, "message1", "failed", { attempts: 2, error: "send failed", errorKind: "unexpected" });

      expect(resolveReview(t.db, prospectId, { stage: "accepted", note: null }, LATER).ok).toBe(true);
      expect(row(`message1:${prospectId}`)).toMatchObject({ status: "planned", attempts: 0, error: null, errorKind: null });
    });

    it.each(["unknown", "in_progress"] as const)("refuses to re-arm a step whose row is %s, and changes nothing", (status) => {
      const prospectId = held();
      stepRow(prospectId, "message1", status, { attempts: 1 });

      expect(resolveReview(t.db, prospectId, { stage: "accepted", note: null }, LATER)).toEqual({ ok: false, kind: "conflict", message: UNKNOWN });
      expect(prospect(prospectId).stage).toBe("needs_review");
      expect(row(`message1:${prospectId}`)).toMatchObject({ status, attempts: 1 });
      expect(messages()).toEqual([]);
    });

    it("refuses a step that was already sent", () => {
      const prospectId = held();
      stepRow(prospectId, "invite", "done", { attempts: 1 });

      expect(resolveReview(t.db, prospectId, { stage: "approved", note: null }, LATER)).toEqual({ ok: false, kind: "conflict", message: "This step was already sent" });
      expect(prospect(prospectId).stage).toBe("needs_review");
    });

    it("resolved past a first message of unknown result, takes it as sent: the row is done and the send time set", () => {
      const prospectId = held({ invitedAt: T0, acceptanceObservedAt: T0 });
      stepRow(prospectId, "invite", "done", { attempts: 1 });
      stepRow(prospectId, "message1", "unknown", { attempts: 1 });

      expect(resolveReview(t.db, prospectId, { stage: "message_sent", note: null }, LATER)).toMatchObject({ ok: true, value: { stage: "message_sent", firstMessageSentAt: STARTED } });
      expect(row(`message1:${prospectId}`)).toMatchObject({ status: "done" });
      expect(row(`invite:${prospectId}`)).toMatchObject({ status: "done" });
    });

    it("resolved past an invite of unknown result, takes it as sent and keeps a send time already there", () => {
      const prospectId = held({ invitedAt: T0 });
      stepRow(prospectId, "invite", "unknown", { attempts: 1 });

      expect(resolveReview(t.db, prospectId, { stage: "accepted", note: null }, LATER)).toMatchObject({ ok: true, value: { invitedAt: T0 } });
      expect(row(`invite:${prospectId}`)).toMatchObject({ status: "done" });
    });

    it("resolved to invited past an invite of unknown result, sets the invite time from the claim", () => {
      const prospectId = held();
      stepRow(prospectId, "invite", "unknown", { attempts: 1 });

      expect(resolveReview(t.db, prospectId, { stage: "invited", note: null }, LATER)).toMatchObject({ ok: true, value: { invitedAt: STARTED } });
      expect(row(`invite:${prospectId}`)).toMatchObject({ status: "done" });
    });
  });

  describe("the time of the stage it continues from", () => {
    it.each([
      ["invited", "invitedAt"],
      ["accepted", "acceptanceObservedAt"],
      ["message_sent", "firstMessageSentAt"],
    ] as const)("resolved to %s, sets %s to now when it is empty", (stage, field) => {
      const { prospectId } = seedPersonProspect(t.db, seedCampaign(t.db, { status: "running" }), 1, "needs_review", { approvedAt: T0 });

      expect(resolveReview(t.db, prospectId, { stage, note: null }, LATER)).toMatchObject({ ok: true, value: { [field]: LATER } });
    });

    it.each([
      ["invited", "invitedAt"],
      ["accepted", "acceptanceObservedAt"],
      ["message_sent", "firstMessageSentAt"],
    ] as const)("resolved to %s, keeps %s when it is already set", (stage, field) => {
      const { prospectId } = seedPersonProspect(t.db, seedCampaign(t.db, { status: "running" }), 1, "needs_review", { approvedAt: T0, [field]: T0 });

      expect(resolveReview(t.db, prospectId, { stage, note: null }, LATER)).toMatchObject({ ok: true, value: { [field]: T0 } });
    });
  });
});

describe("resolveReview with the engine", () => {
  let kit: Kit;
  beforeEach(() => {
    kit = createKit();
    kit.settings({
      actionGapSeconds: { min: 1, max: 1 },
      breaks: { everyActionsMin: 1000, everyActionsMax: 1000, minutesMin: 1, minutesMax: 1 },
    });
  });
  afterEach(() => kit.close());

  it("a person held after three failed first-message attempts and put back to accepted gets the first message, not held again", async () => {
    const p = seedAccepted(kit, engineCampaign(kit));
    for (let attempt = 1; attempt <= 3; attempt++) {
      kit.world.failNext("sendMessage", "timeout_before_effect");
      await step(kit);
      await step(kit);
    }
    await step(kit);
    expect(engineProspect(kit, p.prospectId)).toMatchObject({ stage: "needs_review", reviewReason: "tried 3 times without a confirmed result" });

    expect(resolveReview(kit.db, p.prospectId, { stage: "accepted", note: "Checked: nothing was sent" }, kit.clock.now()).ok).toBe(true);
    await runUntil(kit, () => engineProspect(kit, p.prospectId).stage !== "accepted");

    expect(engineProspect(kit, p.prospectId).stage).toBe("message_sent");
    expect(kit.world.messagesSentTo(p.spec.publicId)).toHaveLength(1);
    expect(actionByKey(kit, `message1:${p.prospectId}`)).toMatchObject({ status: "done", attempts: 1 });
  });
});

describe("setDoNotContact", () => {
  it("sets and clears the flag on the person", () => {
    const personId = seedPerson(t.db, 1);

    expect(setDoNotContact(t.db, personId, true, LATER)).toMatchObject({ ok: true, value: { id: personId, doNotContact: true } });
    expect(setDoNotContact(t.db, personId, false, LATER)).toMatchObject({ ok: true, value: { doNotContact: false } });
    expect(messages()).toEqual(["Test Person 1 marked do not contact", "Test Person 1 no longer marked do not contact"]);
  });

  it("answers not found for an unknown person", () => {
    expect(setDoNotContact(t.db, 99, true, LATER)).toEqual({ ok: false, kind: "not_found", message: "No person 99" });
  });
});
