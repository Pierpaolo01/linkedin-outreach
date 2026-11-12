import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AiUnavailable } from "../ai/types";
import { campaigns, discoveryRuns, people, prospects } from "../db/schema";
import { discoveryWait, EMPTY_LOADS_TO_PAUSE } from "./discovery";
import { activeSafetyStop } from "./safetyStop";
import type { MemberSpec } from "../linkedin/fake/world";
import {
  actionRows,
  addCampaign,
  addPerson,
  addProspect,
  createKit,
  events,
  seedAccepted,
  START,
  step,
  stubAi,
  type Kit,
  type StubAi,
} from "./testKit";

let kit: Kit;
let ai: StubAi;
beforeEach(() => {
  // The AI is down unless a test says otherwise, so found prospects stay found and only discovery runs.
  ai = stubAi({ failWith: new AiUnavailable("stub: down") });
  kit = createKit({ ai });
  kit.settings({
    actionGapSeconds: { min: 1, max: 1 },
    breaks: { everyActionsMin: 1000, everyActionsMax: 1000, minutesMin: 1, minutesMax: 1 },
  });
});
afterEach(() => kit.close());

const SEARCH = "https://www.linkedin.com/search/results/people/?keywords=owner";

let cardSeq = 0;
function members(count: number, spec: Partial<MemberSpec> = {}) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    cardSeq += 1;
    const n = cardSeq;
    const publicId = `card-${n}`;
    kit.world.addMember({ publicId, memberId: `ACoACard${n}`, fullName: `Card Person ${n}`, headline: `Owner at Firm ${n}`, location: "Milan", currentCompany: `Firm ${n} S.R.L.`, degree: 2, ...spec });
    ids.push(publicId);
  }
  return ids;
}

function campaignProspects(campaignId: number) {
  return kit.db.select({ prospect: prospects, person: people }).from(prospects).innerJoin(people, eq(people.id, prospects.personId)).where(eq(prospects.campaignId, campaignId)).all();
}

function runs(campaignId: number) {
  return kit.db.select().from(discoveryRuns).where(eq(discoveryRuns.campaignId, campaignId)).all();
}

/** One tick that did LinkedIn work or nothing: ticks that only tried the (down) AI are skipped. */
async function next(on: Kit = kit) {
  for (;;) {
    const result = await step(on);
    if (!(result.did ?? "").startsWith("scoring:")) return result;
  }
}

const pageLoads = (page: string) => kit.world.log.filter((entry) => entry.kind === "page_load" && entry.page === page).length;

describe("discovery from recommendations", () => {
  it("creates a found prospect and a person from each card, records the page in the ledger and a discovery run", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "recommendations" });
    const ids = members(3);
    kit.world.setRecommendations([{ title: "People you may know", publicIds: ids }]);

    const result = await next();

    expect(result.did).toContain("discovery");
    const found = campaignProspects(c);
    expect(found.map((row) => row.person.publicId).sort()).toEqual([...ids].sort());
    expect(found.every((row) => row.prospect.stage === "found")).toBe(true);
    const first = found.find((row) => row.person.publicId === ids[0]);
    expect(first?.person).toMatchObject({
      fullName: expect.stringContaining("Card Person"),
      headline: expect.stringContaining("Owner at Firm"),
      location: "Milan",
      connectionDegree: 2,
      discoverySource: "recommendations",
      profileUrl: `https://www.linkedin.com/in/${ids[0]}/`,
    });
    expect(first?.person.raw).toMatchObject({ card: { publicId: ids[0] } });
    expect(actionRows(kit).map((row) => row.type)).toEqual(["recommendation_page"]);
    expect(runs(c)).toMatchObject([{ source: "recommendations", sourceUrl: null, exhausted: false, emptyLoads: 0 }]);
  });

  it("after three loads in a row that bring nobody new, waits until tomorrow, never for good", async () => {
    const c = addCampaign(kit, { status: "running", discoverySource: "recommendations" });
    kit.world.setRecommendations([]);
    for (let i = 0; i < 3; i++) expect((await next()).did).toContain("discovery");
    // The start of 17 November in Rome; the count starts again.
    expect(runs(c)).toMatchObject([{ emptyLoads: 0, exhausted: false, pausedUntil: new Date("2026-11-16T23:00:00Z") }]);
    expect(events(kit).filter((line) => line.includes("looks again tomorrow"))).toHaveLength(1);
    expect((await next()).did).toBeNull();
    expect(pageLoads("recommendations")).toBe(3);

    // LinkedIn's suggestions change: the next working day it looks again.
    kit.world.setRecommendations([{ title: "New today", publicIds: members(1) }]);
    kit.clock.set(new Date("2026-11-17T09:00:00Z"));
    expect((await next()).did).toContain("1 new");
    expect(pageLoads("recommendations")).toBe(4);
  });

  it("a load that brings someone new starts the count again", async () => {
    const c = addCampaign(kit, { status: "running", discoverySource: "recommendations" });
    kit.world.setRecommendations([]);
    await next();
    await next();
    kit.world.setRecommendations([{ title: "More", publicIds: members(1) }]);
    await next();
    expect(runs(c)).toMatchObject([{ emptyLoads: 0, exhausted: false }]);
  });
});

describe("discovery from a search", () => {
  it("loads page after page, keeping the next page in the cursor, until there is no next page", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH] });
    kit.world.setSearchResults(SEARCH, members(12));

    await next();
    expect(campaignProspects(c)).toHaveLength(10);
    expect(runs(c)).toMatchObject([{ source: "search", sourceUrl: SEARCH, cursor: "2", exhausted: false }]);
    kit.db.update(prospects).set({ stage: "rejected" }).where(eq(prospects.campaignId, c)).run();

    await next();
    expect(campaignProspects(c)).toHaveLength(12);
    expect(runs(c)).toMatchObject([{ exhausted: true }]);
    expect(actionRows(kit).map((row) => row.type)).toEqual(["search_page", "search_page"]);
    expect((await next()).did).toBeNull();
    expect(pageLoads("search")).toBe(2);
  });

  it("works through each search URL of the campaign in turn", async () => {
    const second = `${SEARCH}&page=x`;
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH, second] });
    kit.world.setSearchResults(SEARCH, members(1));
    kit.world.setSearchResults(second, members(1));
    await next();
    await next();
    expect(runs(c).map((run) => [run.sourceUrl, run.exhausted])).toEqual([
      [SEARCH, true],
      [second, true],
    ]);
    expect(campaignProspects(c)).toHaveLength(2);
  });

  it("LinkedIn's search cap pauses searches until the first instant of next month, with a log line; sequences carry on", async () => {
    const c = addCampaign(kit, { status: "running", discoverySource: "search", sourceUrls: [SEARCH], acceptToMessageMinHours: 0, acceptToMessageMaxHours: 0 });
    const other = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [`${SEARCH}&b`] });
    kit.world.setSearchResults(SEARCH, members(3));
    const accepted = seedAccepted(kit, c);
    kit.world.failNext("searchPeople", "search_capped");

    let did = "";
    for (let i = 0; i < 4 && !did.includes("search limit"); i++) did = (await next()).did ?? "";
    expect(did).toContain("search limit reached");
    // 1 December 2026, 00:00 in Rome.
    expect(runs(c)).toMatchObject([{ pausedUntil: new Date("2026-11-30T23:00:00Z"), exhausted: false }]);
    expect(events(kit).filter((line) => line.includes("monthly search limit"))).toEqual([
      "LinkedIn's monthly search limit is reached: discovery from searches waits until 2026-12-01. Sequences of existing prospects carry on",
    ]);
    // No search of either campaign is loaded again this month; the first message still goes out.
    const searchRows = () => actionRows(kit).filter((row) => row.type === "search_page").length;
    for (let i = 0; i < 6; i++) await next();
    expect(searchRows()).toBe(1);
    expect(runs(other)).toEqual([]);
    expect(kit.world.messagesSentTo(accepted.spec.publicId)).toHaveLength(1);

    kit.clock.set(new Date("2026-12-01T08:00:00Z"));
    for (let i = 0; i < 3 && searchRows() === 1; i++) await next();
    expect(searchRows()).toBe(2);
  });
});

describe("a discovery page the app cannot read", () => {
  const searchRows = () => actionRows(kit).filter((row) => row.type === "search_page");

  it("is loaded once, not again and again: its source waits until the next day, with a log line, and no safety stop is raised", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH] });
    kit.world.setSearchResults(SEARCH, members(3));
    for (let i = 0; i < 3; i++) kit.world.failNext("searchPeople", "unexpected");

    for (let i = 0; i < 5; i++) await next();

    expect(searchRows().map((row) => row.errorKind)).toEqual(["unexpected"]);
    expect(activeSafetyStop(kit.db)).toBeNull();
    // 17 November 2026, 00:00 in Rome.
    const tomorrow = new Date("2026-11-16T23:00:00Z");
    expect(runs(c)).toMatchObject([{ cursor: "1", unreadableUntil: tomorrow, pausedUntil: null, exhausted: false }]);
    expect(events(kit).filter((line) => line.includes("could not be read"))).toEqual([
      expect.stringMatching(/LinkedIn's page could not be read \(search .+ page 1\); this source waits until 2026-11-17\. Sequences of existing prospects carry on$/),
    ]);
    const campaign = kit.db.select().from(campaigns).where(eq(campaigns.id, c)).get();
    if (campaign === undefined) throw new Error("missing campaign");
    expect(discoveryWait(kit.db, campaign, kit.clock.now())).toEqual({ kind: "unreadable", until: tomorrow });
  });

  it("is loaded again the next day", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH] });
    kit.world.setSearchResults(SEARCH, members(3));
    kit.world.failNext("searchPeople", "unexpected");
    for (let i = 0; i < 3; i++) await next();
    expect(campaignProspects(c)).toHaveLength(0);

    kit.clock.set(new Date("2026-11-17T08:00:00Z"));
    for (let i = 0; i < 3 && searchRows().length === 1; i++) await next();

    expect(searchRows().map((row) => row.status)).toEqual(["failed", "done"]);
    expect(campaignProspects(c)).toHaveLength(3);
  });

  it("does not hold back the campaign's other search", async () => {
    const second = `${SEARCH}&b`;
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH, second] });
    kit.world.setSearchResults(SEARCH, members(2));
    kit.world.setSearchResults(second, members(2));
    kit.world.failNext("searchPeople", "unexpected");

    await next();
    await next();

    expect(runs(c).map((run) => [run.sourceUrl, run.unreadableUntil !== null, run.exhausted])).toEqual([
      [SEARCH, true, false],
      [second, false, true],
    ]);
    expect(campaignProspects(c)).toHaveLength(2);
  });

  it("still raises the safety stop when three different pages in a row cannot be read", async () => {
    for (const tag of ["a", "b", "c"]) {
      addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [`${SEARCH}&${tag}`] });
      kit.world.failNext("searchPeople", "unexpected");
    }

    for (let i = 0; i < 3; i++) await next();

    expect(searchRows().map((row) => row.errorKind)).toEqual(["unexpected", "unexpected", "unexpected"]);
    expect(activeSafetyStop(kit.db)?.reason).toBe("unexpected_pages");
  });
});

describe("a search page with a result the app cannot read", () => {
  it("takes the other results, moves on to the next page and says in the log what was left out", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH] });
    kit.world.setSearchResults(SEARCH, members(12));
    kit.world.setSearchSkipped(SEARCH, ["result 7: no profile link"]);

    await next();

    expect(campaignProspects(c)).toHaveLength(10);
    expect(runs(c)).toMatchObject([{ cursor: "2", unreadableUntil: null }]);
    expect(activeSafetyStop(kit.db)).toBeNull();
    expect(events(kit).filter((line) => line.includes("left out"))).toEqual([
      expect.stringMatching(/1 result of page 1 could not be read and was left out \(result 7: no profile link\)\. The page was saved \(search .+\)$/),
    ]);
  });
});

describe("what discovery skips", () => {
  it("skips a 1st-degree card, a person marked do not contact, one ever contacted, one active elsewhere and one already in the campaign", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH] });
    const elsewhere = addCampaign(kit, { status: "paused" });
    const [connection] = members(1, { degree: 1 });
    const dnc = addPerson(kit, {}, { doNotContact: true });
    const contacted = addPerson(kit, {}, { contactedAt: START });
    const active = addPerson(kit);
    addProspect(kit, elsewhere, active.personId, { stage: "pending_approval" });
    const already = addPerson(kit);
    addProspect(kit, c, already.personId, { stage: "rejected" });
    const closedElsewhere = addPerson(kit);
    addProspect(kit, elsewhere, closedElsewhere.personId, { stage: "rejected" });
    const [fresh] = members(1);
    kit.world.setSearchResults(SEARCH, [connection, dnc.spec.publicId, contacted.spec.publicId, active.spec.publicId, already.spec.publicId, closedElsewhere.spec.publicId, fresh].map(String));

    await next();

    const created = campaignProspects(c).filter((row) => row.prospect.stage === "found").map((row) => row.person.publicId);
    expect(created.sort()).toEqual([closedElsewhere.spec.publicId, fresh].sort());
    expect(kit.db.select().from(people).where(eq(people.publicId, String(connection))).all()).toEqual([]);
  });
});

describe("how much discovery runs", () => {
  it("stops while the waiting line holds the batch size, and resumes when it drains", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH], batchSize: 10 });
    kit.world.setSearchResults(SEARCH, members(25));
    await next();
    expect(campaignProspects(c)).toHaveLength(10);
    expect((await next()).did).toBeNull();
    // Half go to the approval queue, half are rejected: still five waiting plus five pending is ten.
    const ids = campaignProspects(c).map((row) => row.prospect.id);
    kit.db.update(prospects).set({ stage: "pending_approval" }).where(eq(prospects.id, ids[0] ?? 0)).run();
    expect((await next()).did).toBeNull();
    kit.db.update(prospects).set({ stage: "rejected" }).where(eq(prospects.id, ids[1] ?? 0)).run();
    expect((await next()).did).toContain("discovery");
    expect(campaignProspects(c)).toHaveLength(20);
  });

  it("creates no more prospects than the target number, and resumes when one is rejected", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH], targetProspectCount: 3 });
    kit.world.setSearchResults(SEARCH, members(25));
    await next();
    expect(campaignProspects(c)).toHaveLength(3);
    expect((await next()).did).toBeNull();
    const [first] = campaignProspects(c);
    kit.db.update(prospects).set({ stage: "rejected" }).where(eq(prospects.id, first?.prospect.id ?? 0)).run();
    expect((await next()).did).toContain("discovery");
    expect(campaignProspects(c).filter((row) => row.prospect.stage !== "rejected")).toHaveLength(3);
  });

  it("keeps a last page that the target cut short and loads it again when there is room, until every card was considered", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH], targetProspectCount: 3 });
    const ids = members(10);
    kit.world.setSearchResults(SEARCH, ids);
    const open = () => campaignProspects(c).filter((row) => row.prospect.stage !== "rejected");
    const rejectAll = () => kit.db.update(prospects).set({ stage: "rejected" }).where(eq(prospects.campaignId, c)).run();

    await next();
    expect(open().map((row) => row.person.publicId)).toEqual(ids.slice(0, 3));
    // Seven people on the page were never looked at: the page is not done, the search not exhausted.
    expect(runs(c)).toMatchObject([{ cursor: "1", exhausted: false }]);

    // All three rejected: the campaign does not complete, the same page is loaded again.
    rejectAll();
    expect((await next()).did).toContain("discovery");
    expect(open().map((row) => row.person.publicId)).toEqual(ids.slice(3, 6));
    expect(runs(c)).toMatchObject([{ cursor: "1", exhausted: false }]);

    rejectAll();
    await next();
    expect(open().map((row) => row.person.publicId)).toEqual(ids.slice(6, 9));
    expect(runs(c)).toMatchObject([{ cursor: "1", exhausted: false }]);

    rejectAll();
    await next();
    expect(open().map((row) => row.person.publicId)).toEqual(ids.slice(9));
    expect(runs(c)).toMatchObject([{ cursor: "2", exhausted: true }]);
    expect(campaignProspects(c)).toHaveLength(10);
    expect(pageLoads("search")).toBe(4);
  });

  it("moves to the next page when the target is reached by the last card that could be taken", async () => {
    const c = addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH], targetProspectCount: 2 });
    const [connection] = members(1, { degree: 1 });
    const fresh = members(2);
    kit.world.setSearchResults(SEARCH, [...fresh, String(connection)]);
    await next();
    expect(campaignProspects(c)).toHaveLength(2);
    // The third card is skipped by a rule, so every card on the page was considered.
    expect(runs(c)).toMatchObject([{ cursor: "2", exhausted: true }]);
  });

  it("does not count a suggestions load cut short by a full target as one that brought nobody new", async () => {
    const lowered = createKit({
      ai,
      wrap: (driver) => ({
        ...driver,
        listRecommendations: async () => {
          // The user lowers the target to what the campaign already holds while the page loads.
          lowered.db.update(campaigns).set({ targetProspectCount: 0 }).run();
          return driver.listRecommendations();
        },
      }),
    });
    try {
      lowered.settings({
        actionGapSeconds: { min: 1, max: 1 },
        breaks: { everyActionsMin: 1000, everyActionsMax: 1000, minutesMin: 1, minutesMax: 1 },
      });
      const c = addCampaign(lowered, { status: "running", discoverySource: "recommendations", targetProspectCount: 5 });
      for (let i = 0; i < 3; i++) {
        lowered.world.addMember({ publicId: `lowered-${i}`, memberId: `ACoALowered${i}`, fullName: `Lowered Person ${i}`, degree: 2 });
      }
      lowered.world.setRecommendations([{ title: "People you may know", publicIds: ["lowered-0", "lowered-1", "lowered-2"] }]);
      for (let i = 0; i < EMPTY_LOADS_TO_PAUSE; i++) {
        expect((await next(lowered)).did).toContain("discovery");
        lowered.db.update(campaigns).set({ targetProspectCount: 5 }).run();
      }
      const [run] = lowered.db.select().from(discoveryRuns).where(eq(discoveryRuns.campaignId, c)).all();
      expect(run).toMatchObject({ emptyLoads: 0, pausedUntil: null, exhausted: false });
    } finally {
      lowered.close();
    }
  });

  it("spends the discovery page budget, shared by search and recommendations pages", async () => {
    kit.settings({ limits: { discoveryPagesPerDay: 2 } });
    addCampaign(kit, { status: "finding", discoverySource: "search", sourceUrls: [SEARCH], batchSize: 100 });
    addCampaign(kit, { status: "finding", discoverySource: "recommendations", batchSize: 100 });
    kit.world.setSearchResults(SEARCH, members(40));
    kit.world.setRecommendations([{ title: "People", publicIds: members(5) }]);
    await next();
    await next();
    expect((await next()).did).toBeNull();
    expect(actionRows(kit).map((row) => row.type).sort()).toEqual(["recommendation_page", "search_page"]);
    // Next working day the budget is open again.
    kit.clock.set(new Date("2026-11-17T08:00:00Z"));
    expect((await next()).did).toContain("discovery");
  });

  it("is not picked without an AI to score what it finds", async () => {
    const plain = createKit();
    try {
      addCampaign(plain, { status: "finding", discoverySource: "recommendations" });
      plain.world.setRecommendations([]);
      expect((await next(plain)).did).toBeNull();
      expect(plain.world.log).toHaveLength(0);
    } finally {
      plain.close();
    }
  });
});
