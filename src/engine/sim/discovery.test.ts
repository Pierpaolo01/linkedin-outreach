/**
 * Proofs for the discovery and AI assertions (9 and 10) and for the discovery parts of 2 and 3:
 * each deliberately broken discovery stub must make its assertion report the violation, and the
 * correct-enough stub must pass the same scenario. The last tests run the real engine on the small
 * discovery scenario, with kills on every discovery operation.
 */
import { describe, expect, it } from "vitest";
import { createEngine } from "../engine";
import { raiseSafetyStop, resumeSafetyStop } from "../safetyStop";
import { NO_KILLS, type ForcedKill, type SimContext } from "./harness";
import { rome } from "./scenario";
import { discoverer, discoveryScenario, inviter, smallScenario } from "./stubs";
import { messages, simulate } from "./testing";

const everyViolation = (verdict: Awaited<ReturnType<typeof simulate>>["verdict"]): string[] =>
  verdict.results.flatMap((result) => result.violations.map((violation) => `${result.id}: ${violation.message}`));

describe("a correct-enough discoverer passes every assertion", () => {
  it("recommendations: loads, scores, opens, waits for approval and invites, with no violation", async () => {
    const { verdict, run } = await simulate(discoverer(), discoveryScenario());
    expect(everyViolation(verdict)).toEqual([]);
    expect(verdict.counts.peopleDiscovered).toBeGreaterThan(15);
    expect(verdict.counts.profilesOpenedForScoring).toBeGreaterThan(5);
    expect(verdict.counts.discoveredInvited).toBeGreaterThan(0);
    expect(verdict.counts.awaitingApprovalReached).toBe(1);
    expect(run.discoveryLoads.length).toBeGreaterThan(2);
  });

  it("search: stops at LinkedIn's search cap while recommendations carry on, with no violation", async () => {
    const { verdict, run } = await simulate(discoverer(), discoveryScenario({ search: true }));
    expect(everyViolation(verdict)).toEqual([]);
    expect(verdict.counts.searchCaps).toBe(1);
    expect(run.searchCapsShown).toHaveLength(1);
  });
});

describe("2. discovery pages and profile views per day", () => {
  it("reports a day over the discovery-page limit when the budget is ignored", async () => {
    // With no waiting line either, nothing stops the loads but the end of the window.
    const { result } = await simulate(discoverer({ ignoreDiscoveryBudget: true, ignoreWaitingLine: true }), discoveryScenario({ days: 1 }));
    expect(messages(result(2))).toEqual([expect.stringMatching(/^2027-03-15: discovery pages \d+ > 10$/)]);
  });
});

describe("3. discovery only inside the working window", () => {
  it("reports recommendations pages and profile views loaded outside it", async () => {
    const { result } = await simulate(discoverer({ ignoreWindow: true }), discoveryScenario({ days: 1 }));
    const found = messages(result(3));
    expect(found[0]).toMatch(/^outside the working window: 2027-03-15T07:\d\d:\d\d\.\d+Z page_load\(recommendations\) -$/);
    expect(found.some((message) => / profile_view sim-member-4\d\d$/.test(message))).toBe(true);
  });
});

describe("9. discovery and scoring", () => {
  it("reports a profile opened for a card that scored below the open-profile threshold", async () => {
    const { result } = await simulate(discoverer({ openEveryProfile: true }), discoveryScenario({ days: 1 }));
    const found = messages(result(9));
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain("sim-member-402: profile opened although the card scored below the open-profile threshold (0 < 6 in G)");
    expect(found).toContain("sim-member-405: profile opened although the card scored below the open-profile threshold (3 < 6 in G)");
  });

  it("reports people contacted before, do-not-contact and with a pending invitation put in the queue and invited", async () => {
    const { result } = await simulate(discoverer({ ignoreExclusions: true }), discoveryScenario());
    const found = messages(result(9));
    expect(found).toContain("sim-member-403 (contacted before): invited by discovery campaign G");
    expect(found).toContain("sim-member-403 (contacted before): LinkedIn received 1 invitation(s), none allowed");
    expect(found).toContain("sim-member-407 (do not contact): invited by discovery campaign G");
    expect(found).toContain("sim-member-410 (pending invite): reached invited in discovery campaign G");
    // Assertion 5 sees the contacted person invited a second time over the install's life.
    expect(messages(result(5))).toContain("sim-member-403 (discovered_contacted_before): invited 2 times over the install's life (1 before the run, 1 by the app)");
  });

  it("reports a 1st-degree connection stored as a prospect", async () => {
    const { result } = await simulate(discoverer({ ignoreExclusions: true }), discoveryScenario({ search: true, days: 1 }));
    expect(messages(result(9))).toContain("sim-member-451 (first degree): a 1st-degree connection was stored as a prospect of H");
  });

  it("reports prospects approved with no score and no reason", async () => {
    const { result } = await simulate(discoverer({ approveUnscored: true }), discoveryScenario({ days: 1 }));
    expect(messages(result(9))).toEqual(expect.arrayContaining([expect.stringMatching(/^prospect \d+ \(sim-member-4\d\d\) is (approved|invited|accepted), approved, without a score and a reason$/)]));
  });

  it("reports a page loaded while the campaign's waiting line held its batch", async () => {
    const { result } = await simulate(discoverer({ ignoreWaitingLine: true }), discoveryScenario({ days: 1, batchSize: 3 }));
    expect(messages(result(9))).toEqual(expect.arrayContaining([expect.stringMatching(/^campaign G loaded a discovery page while its waiting line held \d+ of a batch of 3$/)]));
    const correct = await simulate(discoverer(), discoveryScenario({ days: 1, batchSize: 3 }));
    expect(messages(correct.result(9))).toEqual([]);
  });

  it("reports searches after LinkedIn's search cap, before next month", async () => {
    const { result } = await simulate(discoverer({ ignoreSearchCap: true }), discoveryScenario({ search: true }));
    expect(messages(result(9))).toEqual([expect.stringMatching(/^LinkedIn capped searches at 2027-03-15T\S+, and \d+ search page\(s\) loaded before 2027-03-31T22:00:00\.000Z$/)]);
  });
});

describe("10. AI work is not LinkedIn", () => {
  it("reports a tick that called the AI and loaded a profile", async () => {
    const { result } = await simulate(discoverer({ loadInAiTick: true }), discoveryScenario({ days: 1 }));
    expect(messages(result(10))).toEqual(expect.arrayContaining([expect.stringMatching(/^a tick at \S+ called the AI \d+ time\(s\) and also the driver \((viewProfile|listRecommendations|sendInvite)\)$/)]));
  });

  it("counts AI work at night: an outage over the afternoon leaves cards to score after the window closes", async () => {
    const outage = { from: rome("2027-03-15", 8), until: { kind: "at" as const, at: rome("2027-03-15", 19) } };
    const { verdict, run, result } = await simulate(discoverer(), discoveryScenario({ days: 1, aiOutages: [outage] }));
    expect(messages(result(10))).toEqual([]);
    expect(run.aiCalls.some((call) => !call.answered)).toBe(true);
    expect(verdict.counts.aiCallsAtNight).toBeGreaterThan(0);
  });
});

describe("10. nothing loads during a safety stop", () => {
  it("reports an engine that keeps inviting while a stop is active", async () => {
    const day = "2027-03-15";
    const scenario = {
      ...smallScenario({ members: 60, days: 1 }),
      events: [
        { at: rome(day, 10), label: "a checkpoint stops the app", apply: ({ db, now }: SimContext) => raiseSafetyStop(db, { reason: "checkpoint", detail: "test" }, now) },
        { at: rome(day, 12), label: "the user resumes", apply: ({ db, now }: SimContext) => void resumeSafetyStop(db, now) },
      ],
    };
    // It ignores the daily limit too, so that it still has invites to send while the stop is active.
    const { result } = await simulate(inviter({ ignoreDailyLimit: true }), scenario);
    expect(messages(result(10))).toEqual(expect.arrayContaining([expect.stringMatching(/^LinkedIn loaded during a safety stop \(checkpoint, raised 2027-03-15T09:00:00\.000Z\): 2027-03-15T(09|10):\d\d:\d\d\.\d+Z /)]));
  });
});

describe("the real engine on the small discovery scenario", () => {
  const engine = { createEngine, resumeSafetyStop };
  const killEach: ForcedKill[] = [
    { kind: "nth", op: "listRecommendations", phase: "after", nth: 1 },
    { kind: "nth", op: "listRecommendations", phase: "before", nth: 3 },
    { kind: "nth", op: "searchPeople", phase: "after", nth: 1 },
    { kind: "nth", op: "viewProfile", phase: "after", nth: 2 },
    { kind: "nth", op: "viewProfile", phase: "before", nth: 5 },
  ];

  it("kills on every discovery operation leave no row unknown, nobody stored twice, and no violation", async () => {
    const { verdict, run } = await simulate(engine, discoveryScenario({ search: true, days: 2, kills: { ...NO_KILLS, forced: killEach } }));
    expect(run.kills.filter((kill) => kill.cause === "forced")).toHaveLength(killEach.length);
    expect(everyViolation(verdict)).toEqual([]);
    expect(verdict.counts.killsOnDiscovery).toBe(killEach.length);
    expect(verdict.counts.searchCaps).toBe(1);
  }, 30_000);
});
