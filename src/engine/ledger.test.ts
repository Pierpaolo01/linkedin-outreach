import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actions, people, prospects } from "../db/schema";
import { claimRead, claimStep, closeInterruptedRows, finishAction } from "./ledger";
import { actionByKey, addCampaign, addPerson, addProspect, createKit, person, prospect, type Kit } from "./testKit";

let kit: Kit;
let campaignId: number;
beforeEach(() => {
  kit = createKit();
  campaignId = addCampaign(kit);
});
afterEach(() => kit.close());

function approvedProspect(row: Partial<typeof people.$inferInsert> = {}) {
  const { personId, spec } = addPerson(kit, {}, { memberId: null, ...row });
  kit.db.update(people).set({ memberId: spec.memberId }).where(eq(people.id, personId)).run();
  const prospectId = addProspect(kit, campaignId, personId, { stage: "approved" });
  return { personId, prospectId, spec };
}

describe("claimStep", () => {
  it.each([
    ["counted", 2],
    ["given back by releaseClaim, so its attempts went to zero", 0],
  ])("records each invite attempt's start, keeping an older row's earlier attempt (%s) that had no history", (_label, attempts) => {
    const { prospectId } = approvedProspect();
    const earlier = new Date(kit.clock.now().getTime() - 3_600_000);
    // A row claimed before attempt starts were recorded; the profile load of that attempt happened either way.
    kit.db.insert(actions).values({ type: "invite", status: "planned", idempotencyKey: `invite:${prospectId}`, prospectId, attempts, startedAt: earlier }).run();
    const now = kit.clock.now();
    expect(claimStep(kit.db, { step: "invite", prospectId, text: null }, now).ok).toBe(true);
    expect(actionByKey(kit, `invite:${prospectId}`)?.detail).toEqual({ attemptStarts: [earlier.getTime(), now.getTime()] });
  });

  it("in one go: inserts the step row in progress, counts the attempt, freezes the text and records the suppression", () => {
    const { personId, prospectId } = approvedProspect();
    const now = kit.clock.now();
    const result = claimStep(kit.db, { step: "invite", prospectId, text: "A short note" }, now);
    expect(result.ok).toBe(true);
    expect(actionByKey(kit, `invite:${prospectId}`)).toMatchObject({
      type: "invite",
      status: "in_progress",
      attempts: 1,
      startedAt: now,
      prospectId,
      campaignId,
    });
    expect(prospect(kit, prospectId).inviteNoteSent).toBe("A short note");
    expect(person(kit, personId)).toMatchObject({ contactedAt: now, contactedProspectId: prospectId });
  });

  it("stores what reconcile needs in detail", () => {
    const { prospectId } = approvedProspect();
    kit.db.update(prospects).set({ stage: "accepted" }).where(eq(prospects.id, prospectId)).run();
    const result = claimStep(kit.db, { step: "message1", prospectId, text: "Hello", detail: { userMessagesBefore: 1 } }, kit.clock.now());
    expect(result.ok).toBe(true);
    expect(actionByKey(kit, `message1:${prospectId}`)).toMatchObject({ type: "message", detail: { userMessagesBefore: 1 } });
    expect(prospect(kit, prospectId).firstMessageSent).toBe("Hello");
  });

  it("a second claim of the same step fails and changes nothing", () => {
    const { prospectId } = approvedProspect();
    const first = kit.clock.now();
    expect(claimStep(kit.db, { step: "invite", prospectId, text: null }, first).ok).toBe(true);
    const second = claimStep(kit.db, { step: "invite", prospectId, text: "Other" }, new Date(first.getTime() + 1000));
    expect(second).toEqual({ ok: false, refusal: "not_planned" });
    expect(actionByKey(kit, `invite:${prospectId}`)).toMatchObject({ attempts: 1, startedAt: first });
    expect(prospect(kit, prospectId).inviteNoteSent).toBeNull();
  });

  it("refuses a person contacted by another prospect, and one marked do not contact", () => {
    const other = approvedProspect();
    const otherCampaign = addCampaign(kit);
    kit.db.update(prospects).set({ stage: "rejected" }).where(eq(prospects.id, other.prospectId)).run();
    const second = addProspect(kit, otherCampaign, other.personId, { stage: "approved" });
    kit.db.update(people).set({ contactedAt: kit.clock.now(), contactedProspectId: other.prospectId }).where(eq(people.id, other.personId)).run();
    expect(claimStep(kit.db, { step: "invite", prospectId: second, text: null }, kit.clock.now())).toEqual({ ok: false, refusal: "suppressed" });

    const dnc = approvedProspect({ doNotContact: true });
    expect(claimStep(kit.db, { step: "invite", prospectId: dnc.prospectId, text: null }, kit.clock.now())).toEqual({
      ok: false,
      refusal: "do_not_contact",
    });
    expect(actionRows()).toHaveLength(0);
  });

  it("refuses an invite to a person with no member id", () => {
    const { personId } = addPerson(kit, {}, {});
    const prospectId = addProspect(kit, campaignId, personId);
    expect(claimStep(kit.db, { step: "invite", prospectId, text: null }, kit.clock.now())).toEqual({ ok: false, refusal: "no_member_id" });
  });

  it("refuses when the prospect is no longer in the step's stage or the campaign is not running", () => {
    const { prospectId } = approvedProspect();
    expect(claimStep(kit.db, { step: "message1", prospectId, text: "Hi" }, kit.clock.now())).toEqual({ ok: false, refusal: "stage_changed" });
    const paused = addCampaign(kit, { status: "paused" });
    const p2 = approvedProspect();
    kit.db.update(prospects).set({ campaignId: paused }).where(eq(prospects.id, p2.prospectId)).run();
    expect(claimStep(kit.db, { step: "invite", prospectId: p2.prospectId, text: null }, kit.clock.now())).toEqual({
      ok: false,
      refusal: "campaign_not_running",
    });
  });

  it("is all or nothing: when one write fails, no row is claimed, no text frozen, no suppression recorded", () => {
    const { personId, prospectId } = approvedProspect();
    kit.opened.sqlite.exec(
      "CREATE TRIGGER refuse_contacted BEFORE UPDATE OF contacted_at ON people BEGIN SELECT RAISE(ABORT, 'refused'); END;",
    );
    expect(() => claimStep(kit.db, { step: "invite", prospectId, text: "Note" }, kit.clock.now())).toThrow(/refused/);
    expect(actionByKey(kit, `invite:${prospectId}`)).toBeUndefined();
    expect(prospect(kit, prospectId).inviteNoteSent).toBeNull();
    expect(person(kit, personId).contactedAt).toBeNull();
  });

  it("reuses the text frozen by an earlier claim, never the new one", () => {
    const { prospectId } = approvedProspect();
    kit.db.update(prospects).set({ stage: "accepted" }).where(eq(prospects.id, prospectId)).run();
    const first = claimStep(kit.db, { step: "message1", prospectId, text: "Old text" }, kit.clock.now());
    if (!first.ok) throw new Error("claim failed");
    finishAction(kit.db, first.claim.actionId, { status: "planned" }, kit.clock.now());
    const second = claimStep(kit.db, { step: "message1", prospectId, text: "New text" }, kit.clock.now());
    expect(second.ok && second.claim.text).toBe("Old text");
    expect(prospect(kit, prospectId).firstMessageSent).toBe("Old text");
    expect(actionByKey(kit, `message1:${prospectId}`)?.attempts).toBe(2);
  });

  it("an invite claimed once without a note is sent again without one", () => {
    const { prospectId } = approvedProspect();
    const first = claimStep(kit.db, { step: "invite", prospectId, text: null }, kit.clock.now());
    if (!first.ok) throw new Error("claim failed");
    finishAction(kit.db, first.claim.actionId, { status: "planned" }, kit.clock.now());
    const second = claimStep(kit.db, { step: "invite", prospectId, text: "A note added later" }, kit.clock.now());
    expect(second.ok && second.claim.text).toBeNull();
  });

  it("refuses a fourth attempt with too_many_attempts and changes nothing", () => {
    const { prospectId } = approvedProspect();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = claimStep(kit.db, { step: "invite", prospectId, text: null }, kit.clock.now());
      if (!claimed.ok) throw new Error(`attempt ${attempt} refused: ${claimed.refusal}`);
      finishAction(kit.db, claimed.claim.actionId, { status: "planned" }, kit.clock.now());
    }
    const before = actionByKey(kit, `invite:${prospectId}`);
    expect(claimStep(kit.db, { step: "invite", prospectId, text: null }, new Date(kit.clock.now().getTime() + 1000))).toEqual({
      ok: false,
      refusal: "too_many_attempts",
    });
    expect(actionByKey(kit, `invite:${prospectId}`)).toEqual(before);
    expect(before).toMatchObject({ status: "planned", attempts: 3 });
  });

  it("refuses a message with no text", () => {
    const { prospectId } = approvedProspect();
    kit.db.update(prospects).set({ stage: "accepted" }).where(eq(prospects.id, prospectId)).run();
    expect(claimStep(kit.db, { step: "message1", prospectId, text: "  " }, kit.clock.now())).toEqual({ ok: false, refusal: "no_text" });
  });
});

describe("claimRead and closeInterruptedRows", () => {
  it("a read is a claimed ledger row with a unique key", () => {
    const now = kit.clock.now();
    const a = claimRead(kit.db, { type: "profile_view", prospectId: null, campaignId: null }, now);
    const b = claimRead(kit.db, { type: "profile_view", prospectId: null, campaignId: null }, now);
    const rows = actionRows();
    expect(rows.map((row) => row.id)).toEqual([a, b]);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(2);
    expect(rows.every((row) => row.status === "in_progress" && row.attempts === 1 && row.startedAt?.getTime() === now.getTime())).toBe(true);
  });

  it("an interrupted step row becomes unknown, to be reconciled; it reports how many rows it closed", () => {
    const { prospectId } = approvedProspect();
    const claimed = kit.clock.now();
    expect(claimStep(kit.db, { step: "invite", prospectId, text: null }, claimed).ok).toBe(true);
    const restart = new Date(claimed.getTime() + 60_000);
    expect(closeInterruptedRows(kit.db, restart)).toBe(1);
    expect(actionByKey(kit, `invite:${prospectId}`)).toMatchObject({ status: "unknown", startedAt: claimed, finishedAt: null });
    expect(closeInterruptedRows(kit.db, restart)).toBe(0);
  });

  it.each(["profile_view", "thread_check", "connections_check"] as const)(
    "an interrupted %s read ends failed, kind interrupted, finished at the restart: there is nothing to reconcile",
    (type) => {
      const claimed = kit.clock.now();
      const id = claimRead(kit.db, { type, prospectId: null, campaignId: null }, claimed);
      const restart = new Date(claimed.getTime() + 60_000);
      expect(closeInterruptedRows(kit.db, restart)).toBe(1);
      expect(actionRows().find((row) => row.id === id)).toMatchObject({
        status: "failed",
        errorKind: "interrupted",
        startedAt: claimed,
        finishedAt: restart,
      });
      expect(closeInterruptedRows(kit.db, restart)).toBe(0);
    },
  );

  it("leaves rows that are not in progress alone", () => {
    const now = kit.clock.now();
    const id = claimRead(kit.db, { type: "profile_view", prospectId: null, campaignId: null }, now);
    finishAction(kit.db, id, { status: "done" }, now);
    expect(closeInterruptedRows(kit.db, new Date(now.getTime() + 60_000))).toBe(0);
    expect(actionRows()[0]).toMatchObject({ status: "done", finishedAt: now, errorKind: null });
  });
});

function actionRows() {
  return kit.db.select().from(actions).all();
}
