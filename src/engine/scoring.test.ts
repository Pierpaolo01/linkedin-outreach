import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AiUnavailable } from "../ai/types";
import { campaigns, discoveryRuns, eventLog, people, prospects } from "../db/schema";
import type { MemberSpec } from "../linkedin/fake/world";
import { raiseSafetyStop } from "./safetyStop";
import {
  actionRows,
  addCampaign,
  addPerson,
  addProspect,
  createKit,
  events,
  HOUR,
  MINUTE,
  person,
  prospect,
  seedAccepted,
  seedApproved,
  seedInvited,
  step,
  stubAi,
  type Kit,
  type StubAi,
} from "./testKit";

let kit: Kit;
let ai: StubAi;

function setup(options: Parameters<typeof stubAi>[0] = {}, kitOptions: { outreach?: boolean } = {}) {
  ai = stubAi(options);
  kit = createKit({ ai, ...kitOptions });
  kit.settings({
    actionGapSeconds: { min: 1, max: 1 },
    breaks: { everyActionsMin: 1000, everyActionsMax: 1000, minutesMin: 1, minutesMax: 1 },
  });
}
beforeEach(() => setup());
afterEach(() => kit.close());

/** A campaign collecting prospects; its single recommendations source is exhausted, so nothing is discovered unless a test wants it. */
function collecting(values: Parameters<typeof addCampaign>[1] = {}) {
  return addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [], openProfileThreshold: 6, scoreThreshold: 7, ...values });
}

/** A found prospect: a member of the fake LinkedIn and a person row as discovery stores it (no first name). */
function found(campaignId: number, spec: Partial<MemberSpec> = {}, values: Parameters<typeof addProspect>[3] = {}) {
  const added = addPerson(kit, { headline: "Owner", currentTitle: "Owner", currentCompany: "ROSSI COSTRUZIONI S.R.L.", ...spec }, { firstName: null, company: null });
  const prospectId = addProspect(kit, campaignId, added.personId, { stage: "found", approvedAt: null, ...values });
  return { ...added, prospectId };
}

/**
 * Records every stage change of every prospect from now on, through a temporary trigger in the
 * test's own connection: the lifecycle path, which the final stage alone does not show.
 */
function recordStageMoves(): () => string[] {
  kit.opened.sqlite.exec(`
    CREATE TEMP TABLE stage_moves (prospect_id INTEGER, from_stage TEXT, to_stage TEXT);
    CREATE TEMP TRIGGER record_stage_moves AFTER UPDATE OF stage ON prospects WHEN old.stage <> new.stage
    BEGIN INSERT INTO stage_moves VALUES (new.id, old.stage, new.stage); END;
  `);
  return () =>
    kit.opened.sqlite
      .prepare("SELECT prospect_id AS id, from_stage AS f, to_stage AS t FROM stage_moves ORDER BY rowid")
      .all()
      .map((row) => {
        const { id, f, t } = row as { id: number; f: string; t: string };
        return `${id}: ${f} → ${t}`;
      });
}

const statusOf = (id: number) => kit.db.select().from(campaigns).where(eq(campaigns.id, id)).get()?.status;

const loads = () => kit.world.log.filter((entry) => entry.kind === "page_load" || entry.kind === "profile_view").length;

async function ticks(n: number) {
  const did: (string | null)[] = [];
  for (let i = 0; i < n; i++) did.push((await step(kit)).did);
  return did;
}

describe("card scoring", () => {
  it("scores at most 10 cards of one campaign per AI call and rejects those below the open-profile threshold", async () => {
    const c = collecting({ openProfileThreshold: 5 });
    const all = Array.from({ length: 12 }, () => found(c));
    const low = all[0];
    if (low === undefined) throw new Error("no prospect");
    ai.options.cardScores = { [low.spec.publicId]: 3 };

    await step(kit);
    expect(ai.calls).toEqual([{ method: "scoreCards", cards: 10 }]);
    expect(prospect(kit, low.prospectId)).toMatchObject({
      stage: "rejected",
      cardScore: 3,
      score: 3,
      scoreReason: expect.stringContaining("scores 3"),
      scoreModel: "stub-cards",
      closedAt: expect.any(Date),
    });
    expect(prospect(kit, all[1]?.prospectId ?? 0)).toMatchObject({ stage: "found", cardScore: 5, score: null });

    await step(kit);
    expect(ai.calls[1]).toEqual({ method: "scoreCards", cards: 2 });
    expect(all.every((p) => prospect(kit, p.prospectId).cardScore !== null)).toBe(true);
    expect(loads()).toBe(0);
  });

  it("rejects a card below the open-profile threshold straight from found, never scored", async () => {
    const moves = recordStageMoves();
    const c = collecting({ openProfileThreshold: 5 });
    const low = found(c);
    ai.options.cardScores = { [low.spec.publicId]: 3 };

    await step(kit);

    expect(moves()).toEqual([`${low.prospectId}: found → rejected`]);
  });

  it("rejects straight from found a card scored before the open-profile threshold was raised", async () => {
    const c = collecting({ openProfileThreshold: 5 });
    const p = found(c, {}, { cardScore: 5 });
    kit.db.update(campaigns).set({ openProfileThreshold: 6 }).where(eq(campaigns.id, c)).run();
    const moves = recordStageMoves();

    await step(kit);

    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "rejected", score: 5, closedAt: expect.any(Date) });
    expect(moves()).toEqual([`${p.prospectId}: found → rejected`]);
  });
});

describe("profile view for scoring", () => {
  it("opens only profiles whose card scored at or above the threshold, stores what they show and counts in the profile view budget", async () => {
    kit.settings({ limits: { profileViewsPerDay: 1 } });
    const c = collecting({ openProfileThreshold: 5 });
    const high = found(c, { location: "Rome", degree: 2 }, { cardScore: 7 });
    const second = found(c, {}, { cardScore: 5 });
    found(c, {}, { cardScore: 6, stage: "rejected" });
    ai.options.failWith = new AiUnavailable("stub: down");

    const did = await ticks(3);
    expect(did.filter((d) => d?.startsWith("profile view"))).toHaveLength(1);
    expect(kit.world.log.filter((entry) => entry.kind === "profile_view").map((entry) => entry.publicId)).toEqual([high.spec.publicId]);
    expect(actionRows(kit).map((row) => row.type)).toEqual(["profile_view"]);
    expect(person(kit, high.personId)).toMatchObject({
      memberId: high.spec.memberId,
      headline: "Owner",
      location: "Rome",
      title: "Owner",
      company: "ROSSI COSTRUZIONI S.R.L.",
      connectionDegree: 2,
      profileViewedAt: expect.any(Date),
      raw: { profile: { publicId: high.spec.publicId, currentCompany: "ROSSI COSTRUZIONI S.R.L." } },
    });
    expect(person(kit, second.personId).profileViewedAt).toBeNull();
  });

  it("rejects a connection, a pending invitation and a profile that is not available, with the reason", async () => {
    // Profile scoring is not what this test is about: the AI is down after the views.
    const c = collecting();
    const connected = found(c, { degree: 1 }, { cardScore: 8 });
    const pending = found(c, { invitedOutsideApp: true }, { cardScore: 8 });
    const gone = found(c, {}, { cardScore: 8 });
    kit.db.update(people).set({ publicId: "no-longer-there" }).where(eq(people.id, gone.personId)).run();
    ai.options.failWith = new AiUnavailable("stub: down");

    await ticks(6);

    expect(prospect(kit, connected.prospectId)).toMatchObject({ stage: "rejected", scoreReason: "already a connection", closedAt: expect.any(Date) });
    expect(prospect(kit, pending.prospectId)).toMatchObject({ stage: "rejected", scoreReason: "an invitation is already pending" });
    expect(prospect(kit, gone.prospectId)).toMatchObject({ stage: "rejected", scoreReason: "the profile is not available" });
    expect(actionRows(kit).find((row) => row.prospectId === gone.prospectId)).toMatchObject({ status: "failed", errorKind: "profile_unavailable" });
    expect(kit.world.log.filter((entry) => entry.kind === "invite")).toHaveLength(0);
  });

  it("rejects a connection, a pending invitation and a missing profile straight from found, never scored", async () => {
    const moves = recordStageMoves();
    const c = collecting();
    const connected = found(c, { degree: 1 }, { cardScore: 8 });
    const pending = found(c, { invitedOutsideApp: true }, { cardScore: 8 });
    const gone = found(c, {}, { cardScore: 8 });
    kit.db.update(people).set({ publicId: "no-longer-there" }).where(eq(people.id, gone.personId)).run();
    ai.options.failWith = new AiUnavailable("stub: down");

    await ticks(6);

    expect(moves().sort()).toEqual([connected, pending, gone].map((p) => `${p.prospectId}: found → rejected`).sort());
  });

  it("after a failed load waits 30 minutes before opening the profile again", async () => {
    const c = collecting();
    const p = found(c, {}, { cardScore: 8 });
    ai.options.failWith = new AiUnavailable("stub: down");
    kit.world.failNext("viewProfile", "timeout_before_effect");
    await ticks(4);
    expect(actionRows(kit).filter((row) => row.type === "profile_view")).toHaveLength(1);
    expect(prospect(kit, p.prospectId).stage).toBe("found");
    kit.clock.advance(30 * MINUTE);
    await ticks(2);
    expect(person(kit, p.personId).profileViewedAt).not.toBeNull();
  });

  it("holds for review a profile whose member id belongs to another person", async () => {
    const c = collecting();
    const p = found(c, {}, { cardScore: 8 });
    addPerson(kit, {}, { memberId: p.spec.memberId });
    ai.options.failWith = new AiUnavailable("stub: down");
    await ticks(3);
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "needs_review", reviewReason: expect.stringContaining("same member as person") });
  });
});

describe("profile scoring", () => {
  it("stores the score, its reason and model and the evidence, then the cleaned variables, and queues the prospect for approval", async () => {
    const c = collecting();
    const p = found(c, {}, { cardScore: 8 });
    await ticks(4);
    expect(ai.calls.map((call) => call.method)).toEqual(["scoreProfile", "cleanVariables"]);
    expect(prospect(kit, p.prospectId)).toMatchObject({
      stage: "pending_approval",
      score: 8,
      scoreReason: expect.stringContaining("profile of"),
      scoreModel: "stub-profile",
      aiLine: null,
      approvedAt: null,
    });
    const stored = person(kit, p.personId);
    expect(stored).toMatchObject({
      firstName: "Test",
      company: "ROSSI COSTRUZIONI",
      industryEvidence: { value: "construction", source: "headline", confidence: 0.9 },
      sizeEvidence: { value: "under 50", source: "about", confidence: 0.5 },
    });
    expect(stored.raw).toMatchObject({ cleaned: { company: "ROSSI COSTRUZIONI S.R.L.", companyShort: "ROSSI COSTRUZIONI" } });
    expect(events(kit).some((line) => line.includes("waits for your approval"))).toBe(true);
  });

  it.each([
    ["an invitation is already pending", { connectionState: "pending", degree: 2 }],
    ["already a connection", { connectionState: "connected", degree: 1 }],
  ])("rejects without the AI a person found again whose stored profile showed %s", async (reason, shown) => {
    const c = collecting();
    const p = found(c, {}, { cardScore: 8 });
    // Viewed for an earlier campaign: the profile is not opened again, so what it showed then decides.
    kit.db.update(people).set({ profileViewedAt: kit.clock.now(), raw: { profile: { about: null, currentTitle: null, currentCompany: null, experience: [], ...shown } } }).where(eq(people.id, p.personId)).run();

    await ticks(3);

    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "rejected", scoreReason: reason, approvedAt: null });
    expect(ai.calls).toEqual([]);
  });

  it("rejects a profile scored below the threshold without cleaning its variables", async () => {
    const c = collecting();
    const p = found(c, {}, { cardScore: 8 });
    ai.options.profileScores = { [p.spec.publicId]: 4 };
    await ticks(4);
    expect(ai.calls.map((call) => call.method)).toEqual(["scoreProfile"]);
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "rejected", score: 4, closedAt: expect.any(Date) });
  });

  it("rejects a prospect scored on its profile through scored", async () => {
    const c = collecting();
    const p = found(c, {}, { cardScore: 8 });
    ai.options.profileScores = { [p.spec.publicId]: 4 };
    const moves = recordStageMoves();
    await ticks(4);
    expect(moves()).toEqual([`${p.prospectId}: found → scored`, `${p.prospectId}: scored → rejected`]);
  });

  it("stores the profile text the personal line rests on next to the line", async () => {
    const c = collecting({ aiPersonalise: true });
    const p = found(c, {}, { cardScore: 8 });
    ai.options.personalise = () => ({ line: "Your plant in Monza stands out", evidence: "Plant manager in Monza" });
    await ticks(10);
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "pending_approval", aiLine: "Your plant in Monza stands out", aiLineEvidence: "Plant manager in Monza" });
  });

  it("asks for a line no longer than the room the invite note leaves for it", async () => {
    // "Hey Test, " + line + ", " + 150 characters = 200 at most: 38 characters for the line.
    const c = collecting({ aiPersonalise: true, inviteNote: `Hey {{first_name}}, {{ai_line}}, ${"z".repeat(150)}` });
    found(c, {}, { cardScore: 8 });
    await ticks(10);
    expect(ai.calls.filter((call) => call.method === "personalise")).toEqual([{ method: "personalise", maxLength: 38 }]);
  });

  it("writes again, shorter, an approved prospect's line that makes the invite note too long, before the invite", async () => {
    const c = addCampaign(kit, { status: "running", aiPersonalise: true, inviteNote: "Hey {{first_name}}, {{ai_line}}, would like to connect!" });
    const p = seedApproved(kit, c);
    kit.db.update(prospects).set({ aiLine: `I liked ${"y".repeat(200)}.`, aiLineEvidence: "old" }).where(eq(prospects.id, p.prospectId)).run();
    ai.options.personalise = () => ({ line: "Your plant in Monza stands out", evidence: "Plant manager in Monza" });
    await ticks(1);
    expect(ai.calls).toEqual([{ method: "personalise", maxLength: 166 }]);
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "approved", aiLine: "Your plant in Monza stands out", aiLineEvidence: "Plant manager in Monza" });
    expect(events(kit).some((line) => line.includes("written again"))).toBe(true);
    await ticks(3);
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "invited", inviteNoteSent: "Hey Test, Your plant in Monza stands out, would like to connect!" });
  });

  it("writes a personal line only when the campaign asks for one, and keeps null when the AI has none", async () => {
    const withLine = collecting({ aiPersonalise: true, personalisationInstructions: "mention their trade" });
    const without = collecting();
    const a = found(withLine, {}, { cardScore: 8 });
    const b = found(without, {}, { cardScore: 8 });
    await ticks(10);
    expect(prospect(kit, a.prospectId)).toMatchObject({ stage: "pending_approval", aiLine: "Your work at ROSSI COSTRUZIONI S.R.L. stands out" });
    expect(prospect(kit, b.prospectId)).toMatchObject({ stage: "pending_approval", aiLine: null });
    expect(ai.calls.filter((call) => call.method === "personalise")).toHaveLength(1);

    const none = collecting({ aiPersonalise: true });
    ai.options.personalise = () => null;
    const n = found(none, {}, { cardScore: 8 });
    await ticks(6);
    expect(prospect(kit, n.prospectId)).toMatchObject({ stage: "pending_approval", aiLine: null });
  });

  it("keeps the personal line only with the profile text it rests on: neither is stored when one is missing", async () => {
    const c = collecting({ aiPersonalise: true });
    const noEvidence = found(c, {}, { cardScore: 8 });
    const noLine = found(c, {}, { cardScore: 8 });
    ai.options.personalise = (publicId) =>
      publicId === noEvidence.spec.publicId ? { line: "Your plant in Monza stands out", evidence: "  " } : { line: "", evidence: "Plant manager in Monza" };
    await ticks(14);
    for (const p of [noEvidence, noLine]) {
      expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "pending_approval", aiLine: null, aiLineEvidence: null });
    }
  });

  describe("cleaned variables are checked against what LinkedIn showed", () => {
    /** Scores one prospect to the end, with cleaning answering `cleaned`, and returns the stored person. */
    async function cleanedTo(spec: Partial<MemberSpec>, cleaned: { firstName: string | null; companyShort: string | null }) {
      const c = collecting();
      const p = found(c, spec, { cardScore: 8 });
      ai.cleanVariables = async () => ({ value: cleaned, model: "stub-clean" });
      await ticks(4);
      expect(prospect(kit, p.prospectId).stage).toBe("pending_approval");
      return person(kit, p.personId);
    }

    it.each([
      ["Dott. Marco Rossi 🚀 | Growth", "Marco", "Marco"],
      ["MARCO ROSSI", "Marco", "Marco"],
      ["Nicolò Bianchi", "Nicolo", "Nicolo"],
      ["Maria Alessandra Rossi", "Maria Alessandra", "Maria Alessandra"],
      ["Anna-Maria D'Amico", "D'Amico", "D'Amico"],
      ["Dott. Marco Rossi", "Mario", null],
      ["Dott. Marco Rossi", "Dott.", null],
      ["Marco Rossi", "Marco Bianchi", null],
      ["Alessandra Rossi", "Alessandra Rossi Alessandra", null],
      ["Marco 🚀 Rossi", "🚀", null],
      [`${"A".repeat(41)} Rossi`, "A".repeat(41), null],
      ["Marco Rossi", "Rossi Marco", null],
    ])("from %j keeps the first name %j as %j", async (fullName, firstName, kept) => {
      expect((await cleanedTo({ fullName }, { firstName, companyShort: null })).firstName).toBe(kept);
    });

    it.each([
      ["ROSSI COSTRUZIONI S.R.L.", "Rossi Costruzioni", "Rossi Costruzioni"],
      ["Società Edile Bianchi s.p.a.", "Societa Edile Bianchi", "Societa Edile Bianchi"],
      ["ROSSI COSTRUZIONI S.R.L.", "Rossi Construction Group", "ROSSI COSTRUZIONI S.R.L."],
      ["ROSSI COSTRUZIONI S.R.L.", "Rossi\\nCostruzioni", "ROSSI COSTRUZIONI S.R.L."],
      [`ROSSI ${"COSTRUZIONI ".repeat(8)}S.R.L.`, `Rossi ${"Costruzioni ".repeat(7)}Costruzioni`, `ROSSI ${"COSTRUZIONI ".repeat(8)}S.R.L.`],
    ])("from the company %j keeps the cleaned %j as %j", async (currentCompany, companyShort, kept) => {
      const short = companyShort.replace("\\n", "\n");
      expect((await cleanedTo({ currentCompany }, { firstName: null, companyShort: short })).company).toBe(kept);
    });
  });

  it("approves by itself when the campaign auto-approves", async () => {
    const c = collecting({ autoApprove: true });
    const p = found(c, {}, { cardScore: 8 });
    await ticks(4);
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "approved", approvedAt: expect.any(Date) });
  });

  it("makes one AI call per tick and wakes a second later", async () => {
    const c = collecting();
    found(c, {}, { cardScore: 8 });
    await step(kit); // the profile view
    const before = kit.clock.now();
    const result = await kit.engine.tick();
    expect(ai.calls).toHaveLength(1);
    expect(result.wakeAt).toEqual(new Date(before.getTime() + 1000));
  });
});

describe("campaign status", () => {
  it("moves to awaiting approval when the approval queue reaches the batch size", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "recommendations", batchSize: 2 });
    found(c, {}, { stage: "pending_approval" });
    expect((await step(kit)).did ?? "").not.toMatch(/^campaign:/);
    found(c, {}, { stage: "pending_approval" });
    expect((await step(kit)).did).toBe("campaign: Test campaign awaiting approval");
    expect(kit.db.select().from(campaigns).where(eq(campaigns.id, c)).get()?.status).toBe("awaiting_approval");
  });

  it("moves to awaiting approval when nothing is left to find and someone waits", async () => {
    const c = collecting({ batchSize: 25 });
    found(c, {}, { stage: "pending_approval" });
    expect((await step(kit)).did).toBe("campaign: Test campaign awaiting approval");
  });

  it("completes with a log line when nothing is left and nobody matched", async () => {
    const search = "https://www.linkedin.com/search/results/people/?keywords=none";
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [search] });
    kit.world.setSearchResults(search, []);
    await ticks(5);
    expect(statusOf(c)).toBe("completed");
    expect(events(kit).filter((line) => line.includes("nobody matched"))).toHaveLength(1);
  });

  it("keeps finding while LinkedIn's suggestions had nobody new today: they are looked at again tomorrow", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "recommendations" });
    kit.world.setRecommendations([]);
    await ticks(8);
    expect(statusOf(c)).toBe("finding");
    expect(events(kit).some((line) => line.includes("completed"))).toBe(false);
  });

  describe("awaiting approval with nobody left to approve", () => {
    const SEARCH = "https://www.linkedin.com/search/results/people/?keywords=more";

    it("goes back to finding when more people can still be found", async () => {
      const c = addCampaign(kit, { status: "awaiting_approval", discoverySource: "search", sourceUrls: [SEARCH] });
      found(c, {}, { stage: "rejected" });
      expect((await step(kit)).did).toBe("campaign: Test campaign finding");
      expect(statusOf(c)).toBe("finding");
      expect(events(kit)).toContain("Test campaign: nobody is waiting for your approval; finding more people");
    });

    it("goes back to finding while found prospects are still to be scored", async () => {
      const c = collecting({ status: "awaiting_approval" });
      found(c, {}, { stage: "rejected" });
      found(c);
      ai.options.failWith = new AiUnavailable("stub: down");
      await ticks(2);
      expect(statusOf(c)).toBe("finding");
    });

    it("goes back to finding while LinkedIn's suggestions wait until tomorrow", async () => {
      const c = addCampaign(kit, { status: "awaiting_approval", discoverySource: "recommendations" });
      kit.db.insert(discoveryRuns).values({ campaignId: c, source: "recommendations", pausedUntil: new Date(kit.clock.now().getTime() + HOUR), createdAt: kit.clock.now(), updatedAt: kit.clock.now() }).run();
      found(c, {}, { stage: "rejected" });
      await step(kit);
      expect(statusOf(c)).toBe("finding");
    });

    it("completes with a log line when nothing more can be found", async () => {
      const c = collecting({ status: "awaiting_approval" });
      found(c, {}, { stage: "rejected" });
      expect((await step(kit)).did).toBe("campaign: Test campaign completed");
      expect(statusOf(c)).toBe("completed");
      expect(events(kit)).toContain("Test campaign completed: nobody is left to approve and there is nothing more to find");
    });

    it("completes once its target number of prospects is reached and no sequence is under way", async () => {
      const c = addCampaign(kit, { status: "awaiting_approval", discoverySource: "search", sourceUrls: [SEARCH], targetProspectCount: 1 });
      found(c, {}, { stage: "stopped" });
      await step(kit);
      expect(statusOf(c)).toBe("completed");
    });

    it("runs once the rest of a batch with someone approved during finding is rejected", async () => {
      const c = collecting({ batchSize: 3 });
      // The user approved one while the campaign was still finding; two wait for approval.
      found(c, {}, { stage: "approved", approvedAt: kit.clock.now() });
      const waiting = [found(c, {}, { stage: "pending_approval" }), found(c, {}, { stage: "pending_approval" })];
      expect((await step(kit)).did).toBe("campaign: Test campaign awaiting approval");

      for (const { prospectId } of waiting) kit.db.update(prospects).set({ stage: "rejected" }).where(eq(prospects.id, prospectId)).run();
      expect((await step(kit)).did).toBe("campaign: Test campaign running");
      expect(statusOf(c)).toBe("running");
      expect(events(kit)).toContain("Test campaign is running: nobody is left to approve and 1 prospect is approved");
    });

    it("runs when nobody waits and a prospect is further along than approved", async () => {
      const c = collecting({ status: "awaiting_approval" });
      found(c, {}, { stage: "invited", approvedAt: kit.clock.now() });
      found(c, {}, { stage: "rejected" });
      await step(kit);
      expect(statusOf(c)).toBe("running");
    });

    it("stays awaiting approval while someone waits for approval", async () => {
      const c = collecting({ status: "awaiting_approval" });
      found(c, {}, { stage: "pending_approval" });
      found(c, {}, { stage: "rejected" });
      await ticks(3);
      expect(statusOf(c)).toBe("awaiting_approval");
    });
  });

  it("waits while found prospects are still to be scored", async () => {
    const c = collecting();
    found(c, {}, { stage: "pending_approval" });
    found(c);
    ai.options.failWith = new AiUnavailable("stub: down");
    await ticks(2);
    expect(kit.db.select().from(campaigns).where(eq(campaigns.id, c)).get()?.status).toBe("finding");
  });

  it("runs an auto-approving campaign once its prospects are approved", async () => {
    const c = collecting({ autoApprove: true });
    found(c, {}, { cardScore: 8 });
    await ticks(6);
    expect(kit.db.select().from(campaigns).where(eq(campaigns.id, c)).get()?.status).toBe("running");
  });
});

describe("AI work without LinkedIn", () => {
  it("scores at night and during a safety stop, and loads no LinkedIn page", async () => {
    const c = collecting();
    found(c);
    found(c, {}, { cardScore: 8 });
    kit.clock.set(new Date("2026-11-16T22:00:00Z")); // 23:00 in Rome
    raiseSafetyStop(kit.db, { reason: "checkpoint" }, kit.clock.now());
    const did = await ticks(3);
    expect(did[0]).toContain("scoring: 1 card");
    expect(ai.calls.map((call) => call.method)).toEqual(["scoreCards"]);
    expect(did[1]).toBeNull();
    expect(loads()).toBe(0);
  });
});

describe("AiUnavailable", () => {
  it("changes nothing, writes one warning line, and is not tried again for five minutes", async () => {
    const c = collecting();
    const p = found(c);
    ai.options.failWith = new AiUnavailable("stub: down");
    expect((await step(kit)).did).toBe("scoring: AI not available");
    expect(prospect(kit, p.prospectId)).toMatchObject({ stage: "found", cardScore: null });
    for (let i = 0; i < 5; i++) await step(kit);
    expect(ai.calls).toHaveLength(1);

    kit.clock.advance(5 * MINUTE);
    expect((await step(kit)).did).toBe("scoring: AI not available");
    expect(ai.calls).toHaveLength(2);
    const warnings = kit.db.select().from(eventLog).where(eq(eventLog.level, "warning")).all();
    expect(warnings.map((row) => row.message)).toEqual(["The AI is not available (stub: down); scoring waits and is tried again every few minutes"]);

    ai.options.failWith = null;
    kit.clock.advance(5 * MINUTE);
    await step(kit);
    expect(prospect(kit, p.prospectId).cardScore).toBe(5);
  });

  it("an answer that leaves out a card is a bug: the tick rejects and nothing is stored", async () => {
    const c = collecting();
    const p = found(c);
    const scoreCards = ai.scoreCards.bind(ai);
    ai.scoreCards = async (brief, cards) => {
      const answer = await scoreCards(brief, cards);
      return { ...answer, value: answer.value.slice(1) };
    };
    found(c);
    const error: unknown = await kit.engine.tick().then(
      () => null,
      (rejected: unknown) => rejected,
    );
    // The message reaches the app's log: the prospect's number, never the person's public id.
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toBe(`the AI gave no score for the card of prospect ${p.prospectId}`);
    expect(prospect(kit, p.prospectId).cardScore).toBeNull();
  });

  it("any other error from the AI rejects the tick", async () => {
    const c = collecting();
    found(c);
    ai.options.failWith = new TypeError("a bug");
    await expect(kit.engine.tick()).rejects.toThrow("a bug");
  });
});

describe("outreach off", () => {
  beforeEach(() => {
    kit.close();
    setup({}, { outreach: false });
  });

  it("never sends or reads a thread, while discovery and scoring carry on", async () => {
    const running = addCampaign(kit, { status: "running", discoverySource: "search", sourceUrls: ["https://www.linkedin.com/search/results/people/?keywords=a"], acceptToMessageMinHours: 0, acceptToMessageMaxHours: 0 });
    seedApproved(kit, running);
    seedAccepted(kit, running);
    seedInvited(kit, running, 30);
    const spec = { publicId: "searched-1", memberId: "ACoASearched1", fullName: "Searched One", degree: 2 as const };
    kit.world.addMember(spec);
    kit.world.setSearchResults("https://www.linkedin.com/search/results/people/?keywords=a", [spec.publicId]);
    ai.options.cardScores = { [spec.publicId]: 8 };

    for (let i = 0; i < 30; i++) {
      await step(kit);
      kit.clock.advance(HOUR / 4);
    }

    const kinds = new Set(kit.world.log.map((entry) => entry.kind));
    expect(kinds.has("invite") || kinds.has("message") || kinds.has("withdraw") || kinds.has("thread_read")).toBe(false);
    expect(kit.world.log.filter((entry) => entry.page === "connections" || entry.page === "messaging")).toHaveLength(0);
    const searched = kit.db.select().from(people).where(eq(people.publicId, spec.publicId)).get();
    const searchedProspect = kit.db.select().from(prospects).where(eq(prospects.personId, searched?.id ?? 0)).get();
    expect(searchedProspect?.stage).toBe("pending_approval");
  });
});

describe("outreach on", () => {
  it("keeps the existing order, with profile views for scoring and then discovery last", async () => {
    kit.settings({ warmUp: { enabled: false } });
    const c = addCampaign(kit, { status: "running", discoverySource: "recommendations" });
    seedApproved(kit, c);
    found(c, {}, { cardScore: 8 });
    kit.world.setRecommendations([]);
    ai.options.failWith = new AiUnavailable("stub: down");
    const did = (await ticks(6)).filter((d): d is string => d !== null && !d.startsWith("scoring")).map((d) => d.split(":")[0]);
    // The invite makes the connections check due, which comes before anything new.
    expect(did.slice(0, 4)).toEqual(["invite", "connections check", "profile view", "discovery"]);
  });
});
