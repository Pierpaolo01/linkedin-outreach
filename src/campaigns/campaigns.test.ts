import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { campaigns, eventLog } from "../db/schema";
import {
  archiveCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  previewCampaign,
  resumeCampaign,
  startCampaign,
  updateCampaign,
} from "./campaigns";
import { approveProspect } from "./prospects";
import { openTestDb, seedCampaign, seedPerson, seedPersonProspect, seedProspect, T0, type TestDb } from "./testSeed";

const LATER = new Date(T0.getTime() + 60_000);

let t: TestDb;
beforeEach(() => {
  t = openTestDb();
});
afterEach(() => t.close());

function statusOf(id: number) {
  return t.db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, id)).get()?.status;
}

describe("createCampaign", () => {
  it("stores a draft with the wizard's defaults for anything not given", () => {
    const created = createCampaign(t.db, { name: "Founders in Milan" }, T0);

    expect(created).toMatchObject({
      name: "Founders in Milan",
      status: "draft",
      discoverySource: "recommendations",
      sourceUrls: [],
      batchSize: 25,
      autoApprove: true,
      scoreThreshold: 7,
      openProfileThreshold: 6,
      inviteNote: null,
      acceptToMessageMinHours: 24,
      acceptToMessageMaxHours: 48,
      delayPolicy: "calendar",
      withdrawAfterDays: 21,
      createdAt: T0,
      funnel: { found: 0, approved: 0, invited: 0, accepted: 0, messaged: 0, replied: 0 },
    });
    expect(getCampaign(t.db, created.id)).toEqual({ ok: true, value: created });
  });
});

describe("getCampaign", () => {
  it("answers not found for an unknown id", () => {
    expect(getCampaign(t.db, 99)).toEqual({ ok: false, kind: "not_found", message: "No campaign 99" });
  });
});

describe("listCampaigns", () => {
  it("counts the funnel from lifecycle timestamps, not only the current stage", () => {
    const id = seedCampaign(t.db, { status: "running" });
    seedPersonProspect(t.db, id, 1, "pending_approval");
    seedPersonProspect(t.db, id, 2, "approved", { approvedAt: T0 });
    seedPersonProspect(t.db, id, 3, "withdrawn", { approvedAt: T0, invitedAt: T0 });
    seedPersonProspect(t.db, id, 4, "stopped", {
      approvedAt: T0,
      invitedAt: T0,
      acceptanceObservedAt: T0,
      firstMessageSentAt: T0,
      replyDetectedAt: T0,
    });
    seedPersonProspect(t.db, id, 5, "completed", {
      approvedAt: T0,
      invitedAt: T0,
      acceptanceObservedAt: T0,
      firstMessageSentAt: T0,
      followUpSentAt: T0,
    });
    const other = seedCampaign(t.db, { name: "Other" });

    const listed = listCampaigns(t.db);

    expect(listed.map((c) => [c.id, c.status, c.funnel])).toEqual([
      [other, "draft", { found: 0, approved: 0, invited: 0, accepted: 0, messaged: 0, replied: 0 }],
      [id, "running", { found: 5, approved: 4, invited: 3, accepted: 2, messaged: 2, replied: 1 }],
    ]);
  });
});

describe("updateCampaign", () => {
  it("changes any field of a draft", () => {
    const id = seedCampaign(t.db, { name: "Old" });

    const result = updateCampaign(t.db, id, { name: "New", scoringBrief: "Owners", batchSize: 10 }, LATER);

    expect(result).toMatchObject({ ok: true, value: { campaign: { name: "New", scoringBrief: "Owners", batchSize: 10, updatedAt: LATER }, notice: null } });
  });

  it("changes templates and timings of a started campaign and says edits apply to steps not yet sent", () => {
    const id = seedCampaign(t.db, { status: "running" });

    const result = updateCampaign(t.db, id, { firstMessage: "Hello {{first_name}}", withdrawAfterDays: 14 }, LATER);

    expect(result).toMatchObject({
      ok: true,
      value: {
        campaign: { firstMessage: "Hello {{first_name}}", withdrawAfterDays: 14 },
        notice: "Saved. Edits apply only to steps not yet sent; texts already sent stay as they were.",
      },
    });
  });

  it("refuses other fields of a started campaign", () => {
    const id = seedCampaign(t.db, { status: "paused" });

    expect(updateCampaign(t.db, id, { name: "New", firstMessage: "Hi" }, LATER)).toEqual({
      ok: false,
      kind: "conflict",
      message: "Once a campaign has started only its templates and timings can change. These cannot: name",
    });
  });

  it("refuses a template on a started campaign that the engine could not send", () => {
    const id = seedCampaign(t.db, { status: "running" });

    expect(updateCampaign(t.db, id, { firstMessage: "Hi {{nome}}" }, LATER)).toMatchObject({
      ok: false,
      kind: "invalid",
      fields: { firstMessage: expect.stringMatching(/^\{\{nome\}\} is not a variable/) },
    });
  });

  it("refuses any edit of an archived campaign", () => {
    const id = seedCampaign(t.db, { status: "archived" });

    expect(updateCampaign(t.db, id, { firstMessage: "Hi" }, LATER)).toEqual({
      ok: false,
      kind: "conflict",
      message: "An archived campaign cannot be edited",
    });
  });

  it("answers not found for an unknown id", () => {
    expect(updateCampaign(t.db, 99, { name: "x" }, LATER)).toMatchObject({ ok: false, kind: "not_found" });
  });
});

describe("startCampaign", () => {
  it("moves a valid draft to finding and logs it", () => {
    const id = seedCampaign(t.db);

    expect(startCampaign(t.db, id, LATER)).toMatchObject({ ok: true, value: { status: "finding" } });
    expect(t.db.select().from(eventLog).all().map((e) => e.message)).toEqual(['Campaign "Test campaign" started']);
  });

  it("refuses an invalid draft with field messages and leaves it a draft", () => {
    const id = seedCampaign(t.db, { name: "", scoringBrief: "" });

    expect(startCampaign(t.db, id, LATER)).toEqual({
      ok: false,
      kind: "invalid",
      message: "The campaign cannot start yet",
      fields: { name: "Give the campaign a name", scoringBrief: "Describe who fits this campaign and who does not" },
    });
    expect(statusOf(id)).toBe("draft");
  });

  it("starts with auto-approve on without asking for a confirmation", () => {
    const id = seedCampaign(t.db, { autoApprove: true });

    expect(startCampaign(t.db, id, LATER)).toMatchObject({ ok: true, value: { status: "finding", autoApprove: true } });
  });

  it("refuses to start a campaign that is not a draft", () => {
    const id = seedCampaign(t.db, { status: "running" });

    expect(startCampaign(t.db, id, LATER)).toEqual({
      ok: false,
      kind: "conflict",
      message: "Only a draft can be started; this campaign is running",
    });
  });
});

describe("pause and resume", () => {
  it.each(["finding", "awaiting_approval", "running"] as const)("returns a campaign paused while %s to that status", (from) => {
    const id = seedCampaign(t.db, { status: from });

    expect(pauseCampaign(t.db, id, T0)).toMatchObject({ ok: true, value: { status: "paused" } });
    expect(resumeCampaign(t.db, id, LATER)).toMatchObject({ ok: true, value: { status: from } });
  });

  it("returns to the status stored when it was paused, not a guess from its prospects", () => {
    // Running with nobody approved yet: a guess from the prospects would say finding.
    const id = seedCampaign(t.db, { status: "paused", pausedFrom: "running" });

    expect(resumeCampaign(t.db, id, LATER)).toMatchObject({ ok: true, value: { status: "running" } });
    expect(t.db.select({ pausedFrom: campaigns.pausedFrom }).from(campaigns).where(eq(campaigns.id, id)).get()).toEqual({ pausedFrom: null });
  });

  it("remembers the status it was paused from without the activity log", () => {
    const id = seedCampaign(t.db, { status: "running" });
    pauseCampaign(t.db, id, T0);
    t.db.delete(eventLog).run();

    expect(resumeCampaign(t.db, id, LATER)).toMatchObject({ ok: true, value: { status: "running" } });
  });

  it.each([
    ["running", "approved"],
    ["awaiting_approval", "pending_approval"],
    ["finding", "found"],
  ] as const)("guesses %s for a campaign paused before the status was stored, from a prospect %s", (to, stage) => {
    const id = seedCampaign(t.db, { status: "paused", pausedFrom: null });
    seedPersonProspect(t.db, id, 1, stage, stage === "approved" ? { approvedAt: T0 } : {});

    expect(resumeCampaign(t.db, id, LATER)).toMatchObject({ ok: true, value: { status: to } });
  });

  it("goes to running when prospects were approved while paused awaiting approval", () => {
    const id = seedCampaign(t.db, { status: "awaiting_approval" });
    const { prospectId } = seedPersonProspect(t.db, id, 1, "pending_approval");
    pauseCampaign(t.db, id, T0);
    approveProspect(t.db, prospectId, LATER);

    expect(statusOf(id)).toBe("paused");
    expect(resumeCampaign(t.db, id, new Date(LATER.getTime() + 1))).toMatchObject({ ok: true, value: { status: "running" } });
  });

  it("refuses to pause a draft and to resume a running campaign", () => {
    const draft = seedCampaign(t.db);
    const running = seedCampaign(t.db, { status: "running" });

    expect(pauseCampaign(t.db, draft, T0)).toMatchObject({ ok: false, kind: "conflict" });
    expect(resumeCampaign(t.db, running, T0)).toEqual({
      ok: false,
      kind: "conflict",
      message: "Only a paused campaign can be resumed; this campaign is running",
    });
  });
});

describe("archiveCampaign", () => {
  it("archives a campaign once", () => {
    const id = seedCampaign(t.db, { status: "running" });

    expect(archiveCampaign(t.db, id, T0)).toMatchObject({ ok: true, value: { status: "archived" } });
    expect(archiveCampaign(t.db, id, T0)).toEqual({ ok: false, kind: "conflict", message: "This campaign is already archived" });
  });
});

describe("previewCampaign", () => {
  it("renders against invented sample values when the campaign has found nobody", () => {
    const id = seedCampaign(t.db);

    expect(previewCampaign(t.db, id, {})).toEqual({
      ok: true,
      value: {
        samples: "invented",
        items: [
          {
            prospectId: null,
            fullName: "Sample person",
            inviteNote: { ok: true, text: "Hi Anna, I work with companies like Example Srl.", length: 48 },
            firstMessage: { ok: true, text: "Thanks for connecting, Anna.", length: 28 },
            followUp: { ok: true, text: "Any thoughts, Anna?", length: 19 },
          },
        ],
      },
    });
  });

  it("renders against up to three real prospects, first found first, with draft overrides", () => {
    const id = seedCampaign(t.db);
    for (let n = 1; n <= 4; n += 1) seedPersonProspect(t.db, id, n, "pending_approval");
    const noFirstName = seedPerson(t.db, 5, { firstName: null });
    seedProspect(t.db, seedCampaign(t.db), noFirstName, "found");

    const result = previewCampaign(t.db, id, { firstMessage: "Hi {{first_name}} of {{company}}", followUp: "" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.samples).toBe("prospects");
    expect(result.value.items.map((item) => [item.fullName, item.firstMessage, item.followUp])).toEqual([
      ["Test Person 1", { ok: true, text: "Hi Test of Example Company 1", length: 28 }, null],
      ["Test Person 2", { ok: true, text: "Hi Test of Example Company 2", length: 28 }, null],
      ["Test Person 3", { ok: true, text: "Hi Test of Example Company 3", length: 28 }, null],
    ]);
  });

  it("shows the render problem for a person without the needed value", () => {
    const id = seedCampaign(t.db);
    seedProspect(t.db, id, seedPerson(t.db, 1, { firstName: null }), "pending_approval");

    const result = previewCampaign(t.db, id, {});

    expect(result.ok && result.value.items[0]?.firstMessage).toEqual({
      ok: false,
      problem: "unresolved_variable",
      variables: ["first_name"],
      message: "No value for {{first_name}} for this person",
    });
  });

  it("stands in for an AI line still to be written, but not for one the AI already declined", () => {
    const id = seedCampaign(t.db, { aiPersonalise: true, firstMessage: "Hi. {{ai_line}}" });
    seedPersonProspect(t.db, id, 1, "found", { aiLine: null });
    seedPersonProspect(t.db, id, 2, "pending_approval", { aiLine: null });

    const result = previewCampaign(t.db, id, {});

    expect(result.ok && result.value.items.map((item) => item.firstMessage)).toEqual([
      { ok: true, text: "Hi. [AI-written line]", length: 21 },
      { ok: false, problem: "unresolved_variable", variables: ["ai_line"], message: "No value for {{ai_line}} for this person" },
    ]);
  });

  it("answers not found for an unknown id", () => {
    expect(previewCampaign(t.db, 99, {})).toMatchObject({ ok: false, kind: "not_found" });
  });
});
