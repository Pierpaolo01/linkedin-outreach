/**
 * A simulation that cannot detect a bug is worthless: each deliberately broken stub engine below
 * must make its assertion report the violation, and the correct-enough stub must pass the same
 * check (so the assertion is not just always failing). None of this uses the real engine.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { actions, people, prospects } from "../../db/schema";
import { NO_KILLS, type KillPlan, type SimContext } from "./harness";
import type { Expectation, Scenario } from "./harness";
import {
  applySettings,
  closeMidRead,
  createCampaign,
  enrol,
  lowerMessageLimitMidRead,
  pauseMidRead,
  replyMidSend,
  rome,
  synthetic,
  TEMPLATES,
  THREE_WEEK_MINIMUMS,
  threeWeekScenario,
} from "./scenario";
import { idle, inviter, messenger, smallScenario } from "./stubs";
import { acceptedConnection, messages, simulate } from "./testing";

const killOnce = (op: "sendInvite", phase: "after"): KillPlan => ({ ...NO_KILLS, forced: [{ kind: "nth", op, phase, nth: 1 }] });
const HOUR_MS = 3_600_000;

/** A scripted member of campaign A, approved at the start, with the path it must end on. */
function scriptedMember(context: SimContext, n: number, expect: Expectation): void {
  const member = synthetic(n, { acceptsAfterHours: 5 });
  enrol(context, { campaign: "A", member: member.spec, role: "scripted", firstName: member.firstName, company: member.company, scripted: true, expect });
}

/** A do-not-contact person, and a person the app invited in an earlier campaign before the run. */
function traps(context: SimContext): void {
  const dnc = synthetic(301, { acceptsAfterHours: 5 });
  enrol(context, { campaign: "A", member: dnc.spec, role: "do_not_contact", firstName: dnc.firstName, company: dnc.company, person: { doNotContact: true } });
  const earlier = synthetic(302, { acceptsAfterHours: 5 });
  enrol(context, { campaign: "A", member: earlier.spec, role: "contacted_before_run", firstName: earlier.firstName, company: earlier.company });
  context.db.update(people).set({ contactedAt: new Date(context.now.getTime() - 20 * 86_400_000) }).where(eq(people.publicId, earlier.spec.publicId)).run();
  const fact = context.facts.members.get(earlier.spec.publicId);
  if (fact !== undefined) {
    fact.preRunInvites = 1;
    fact.trapSince = context.now;
  }
}

describe("a correct-enough stub passes every assertion", () => {
  it("inviter on a small scenario: no violation anywhere", async () => {
    const { verdict } = await simulate(inviter(), smallScenario({ members: 20, extra: traps }));
    expect(verdict.results.flatMap((result) => result.violations.map((violation) => `${result.id}: ${violation.message}`))).toEqual([]);
    expect(verdict.counts.invites).toBeGreaterThan(10);
  });
});

describe("1. no step twice", () => {
  it("reports an invite sent again after a kill that came between the send and its record", async () => {
    const { result } = await simulate(inviter({ noClaim: true }), smallScenario({ members: 5, kills: killOnce("sendInvite", "after") }));
    expect(messages(result(1))).toEqual(["sim-member-001: the app tried to invite again after its own invite (LinkedIn refused it)"]);
  });

  it("reports a message sent again after a kill that came between the send and its record", async () => {
    const scenario = smallScenario({
      members: 0,
      kills: { ...NO_KILLS, forced: [{ kind: "nth", op: "sendMessage", phase: "after", nth: 1 }] },
      extra: (context) => acceptedConnection(context, 205),
    });
    const { result } = await simulate(messenger({ blind: true }), scenario);
    expect(messages(result(1))).toContain("sim-member-205: the same text was sent twice by the app");
    expect(messages(result(1))).toContain("sim-member-205: the conversation shows the same app text twice");
  });

  it("reports a message whose template could not resolve the name ('Hi ,')", async () => {
    const scenario = smallScenario({
      members: 0,
      extra: (context) => {
        acceptedConnection(context, 211);
        const fact = context.facts.members.get("sim-member-211");
        const prospect = fact?.prospects[0];
        if (fact === undefined || prospect === undefined) throw new Error("no fact");
        // The scenario expects no first name, so the only acceptable outcome is a hold.
        fact.prospects[0] = { ...prospect, firstName: null };
      },
    });
    const { result } = await simulate(messenger(), scenario);
    expect(messages(result(1))).toEqual([
      "sim-member-211: the app's first message is not the template rendered for this person (unresolved name, glued draft or a step sent twice)",
    ]);
  });
});

describe("2. no limit exceeded", () => {
  it("reports a day over the warm-up allowance computed from the world's log", async () => {
    const { result } = await simulate(inviter({ ignoreDailyLimit: true }), smallScenario({ members: 40, days: 1 }));
    expect(messages(result(2))).toContain("2027-03-15: invites 40 > 5");
    expect(messages(result(2))).toContain("2027-03-15: invites (daily limit) 40 > 15");
  });
});

describe("3. nothing outside working hours", () => {
  it("reports every page load and send outside the window", async () => {
    const { result } = await simulate(inviter({ ignoreWindow: true }), smallScenario({ members: 5, days: 1 }));
    const found = messages(result(3));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toMatch(/^outside the working window: 2027-03-15T07:\d\d:\d\d\.\d+Z profile_view sim-member-001$/);
    const correct = await simulate(inviter(), smallScenario({ members: 5, days: 1 }));
    expect(messages(correct.result(3))).toEqual([]);
  });
});

describe("3. a read the laptop slept through", () => {
  const day = "2027-03-15";
  const lateRead = (): Scenario => ({
    // The laptop opens at 17:45; the first profile view of the scripted member takes two hours.
    ...smallScenario({ members: 0, downtimes: [{ from: rome(day, 8), to: rome(day, 17, 45) }], extra: (context) => scriptedMember(context, 271, { kind: "never_greeted" }) }),
    suspensions: { slots: [{ from: rome(day, 17, 45), to: rome(day, 17, 50), ms: 2 * HOUR_MS }], randomChance: 0, lateWithinMs: 0, lateMs: 0, otherMs: [0, 0] },
  });

  it("reports a send the app started after it, and does not count the read's own late page load", async () => {
    // Neither looks at the window again before it claims nor gives the driver a deadline.
    const { run, result } = await simulate(inviter({ noRecheckBeforeClaim: true, ignoreGuard: true }), lateRead());
    expect(run.suspensions).toMatchObject([{ op: "viewProfile", target: "sim-member-271", cause: "slot" }]);
    expect(messages(result(3))).toEqual([expect.stringMatching(/^outside the working window: 2027-03-15T18:4\d:\d\d\.\d+Z invite sim-member-271$/)]);
    expect(result(3).notes[1]).toMatch(/1 reads the laptop slept through \(1 planned, 0 stretched to just before a planned send, 0 random\); 1 of their own page loads landed after the window closed/);
  });

  it("a stub that looks at the window again before it claims passes, and invites the next morning", async () => {
    const { run, result } = await simulate(inviter(), lateRead());
    expect(messages(result(3))).toEqual([]);
    expect(run.suspensions).toHaveLength(1);
    expect(run.world.invitesTo("sim-member-271").map((entry) => entry.at.toISOString().slice(0, 10))).toEqual(["2027-03-16"]);
  });
});

describe("3. a send the laptop sleeps through", () => {
  // The member's profile view is stretched to land at 17:52; the invite then takes two hours.
  const lateSend = (): Scenario => ({
    ...smallScenario({ members: 0, extra: (context) => scriptedMember(context, 291, { kind: "send_slept_through", op: "sendInvite" }) }),
    suspensions: {
      slots: [],
      sends: [{ op: "sendInvite", target: "sim-member-291", startsBeforeEndMs: 8 * 60_000, ms: 2 * HOUR_MS }],
      randomChance: 0,
      lateWithinMs: 0,
      lateMs: 0,
      otherMs: [0, 0],
    },
  });

  it("reports an invite that goes out when the laptop wakes after the window closed, with no excuse", async () => {
    const { run, result } = await simulate(inviter({ ignoreGuard: true }), lateSend());
    expect(run.suspensions.map((one) => `${one.op} ${one.cause} ${one.startedAt.toISOString()} → ${one.landsAt.toISOString()}`)).toEqual([
      "viewProfile lead_in 2027-03-15T08:00:00.000Z → 2027-03-15T16:52:00.000Z",
      "sendInvite send_sleep 2027-03-15T16:52:00.000Z → 2027-03-15T18:52:00.000Z",
    ]);
    expect(messages(result(3))).toEqual(["outside the working window: 2027-03-15T18:52:00.000Z invite sim-member-291"]);
    expect(messages(result(7))).toEqual([
      "sim-member-291 (scripted): their invite went out outside the working window after the laptop slept through it",
      "sim-member-291 (scripted): their invite never went out in a later window after the laptop slept through it (ends invited)",
    ]);
  });

  it("a stub that gives the driver the window's end as its deadline passes, and invites in the next window", async () => {
    const { run, verdict, result } = await simulate(inviter(), lateSend());
    expect(messages(result(3))).toEqual([]);
    expect(messages(result(7))).toEqual([]);
    expect(verdict.counts.suspendedSendsPlanned).toBe(1);
    expect(run.world.invitesTo("sim-member-291").map((entry) => entry.at.toISOString().slice(0, 10))).toEqual(["2027-03-16"]);
  });
});

describe("2. a limit the user lowers while a read loads", () => {
  // Four connections due a first message; the limit drops to the day's count while the third one's thread loads.
  const lowered = (): Scenario => ({
    ...smallScenario({ members: 0, days: 2, extra: (context) => [401, 402, 403, 404].forEach((n) => acceptedConnection(context, n)) }),
    interventions: [lowerMessageLimitMidRead("sim-member-403")],
  });

  it("reports a message sent after it, judged by the limit then; a stub that asks the budget again before it claims passes", async () => {
    const { result } = await simulate(messenger({ noBudgetRecheck: true }), lowered());
    expect(messages(result(2))).toEqual(["2027-03-15: messages 3 > 2"]);
    const correct = await simulate(messenger(), lowered());
    expect(messages(correct.result(2))).toEqual([]);
    expect(correct.verdict.counts.settingsChangedMidRead).toBe(1);
    expect(correct.result(2).notes.at(-1)).toMatch(/^2 settings change\(s\) during the run/);
    expect(["sim-member-403", "sim-member-404"].map((id) => correct.run.world.messagesSentTo(id).map((entry) => entry.at.toISOString().slice(0, 10)))).toEqual([["2027-03-16"], ["2027-03-16"]]);
  });
});

describe("2. the weekly invite limit", () => {
  const week = (invitesPerWeek: number): Scenario =>
    smallScenario({
      members: 40,
      days: 7,
      extra: (context) => applySettings(context, { warmUp: { enabled: false }, limits: { invitesPerDay: 15, invitesPerWeek } }),
    });

  it("counts a week the weekly limit ended before the day's allowance, and not one where both ended together", async () => {
    const stopped = await simulate(inviter(), week(20));
    expect(stopped.verdict.counts.weeksStoppedByWeeklyLimit).toBe(1);
    expect(stopped.result(7).notes[0]).toBe("weeks the weekly invite limit, not the daily one, ended invites: week of 2027-03-15: 20 reached on 2027-03-16 with 5 of 15 that day");
    expect(messages(stopped.result(2))).toEqual([]);
    const together = await simulate(inviter(), week(30));
    expect(together.verdict.counts.weeksStoppedByWeeklyLimit).toBe(0);
  });
});

describe("4. nothing after a reply or a manual message", () => {
  const scenario = () =>
    smallScenario({
      members: 0,
      extra: (context) => {
        acceptedConnection(context, 221, { repliesBeforeFirstMessageAfterHours: 1 });
        acceptedConnection(context, 222, { userWritesAfterHours: 2 });
        acceptedConnection(context, 223);
      },
    });

  it("reports a message sent without reading the thread after the member wrote or the user wrote by hand", async () => {
    const { result } = await simulate(messenger({ blind: true }), scenario());
    expect(messages(result(4))).toEqual([
      "sim-member-221: the app sent a message after a reply",
      "sim-member-222: the app sent a message after a manual message",
    ]);
  });

  it("a messenger that reads the thread first stops both and passes", async () => {
    const { run, result } = await simulate(messenger(), scenario());
    expect(messages(result(4))).toEqual([]);
    expect(run.world.log.filter((entry) => entry.kind === "message").map((entry) => entry.publicId)).toEqual(["sim-member-223"]);
  });

  it("reports a message sent after a reply that landed between the thread read and the send, however close; a stub that heeds the driver passes", async () => {
    const midSend = (): Scenario => ({
      ...smallScenario({ members: 0, extra: (context) => acceptedConnection(context, 225, {}, { expect: { kind: "replies_mid_send" } }) }),
      interventions: [replyMidSend("sim-member-225")],
    });
    const { run, result } = await simulate(messenger({ ignoreThreadChanged: true }), midSend());
    const [read, reply, sent] = [
      run.world.log.find((entry) => entry.kind === "thread_read")?.at,
      run.world.thread("sim-member-225").find((message) => message.source === "member")?.at,
      run.world.log.find((entry) => entry.kind === "message")?.at,
    ].map((at) => at?.getTime() ?? Number.NaN);
    // The reply landed after the pre-send read had loaded (the same instant: no time passes between the two calls) and before the send.
    expect(read).toBeLessThanOrEqual(reply ?? Number.NaN);
    expect(sent).toBeGreaterThan(reply ?? Number.NaN);
    expect(messages(result(4))).toEqual(["sim-member-225: the app sent a message after a reply"]);
    expect(messages(result(7))).toEqual(
      expect.arrayContaining([
        "sim-member-225 (accepted): 1 message(s) from the app after their reply landed mid-send",
        "sim-member-225 (accepted): replied between the thread read and the send and ends message_sent, not stopped (replied)",
      ]),
    );
    const correct = await simulate(messenger(), midSend());
    expect(messages(correct.result(4))).toEqual([]);
    expect(messages(correct.result(7))).toEqual([]);
    expect(correct.verdict.counts.repliesMidSend).toBe(1);
  });
});

describe("5. nobody contacted in a second campaign", () => {
  it("reports a do-not-contact person and a person contacted before, both invited", async () => {
    const { result } = await simulate(inviter({ ignoreSuppression: true }), smallScenario({ members: 2, extra: traps }));
    const found = messages(result(5));
    expect(found).toContain("sim-member-301: do-not-contact person was invited");
    expect(found).toContain("sim-member-302 (contacted_before_run): invited 2 times over the install's life (1 before the run, 1 by the app)");
    expect(found).toContain("sim-member-302 (contacted_before_run): contacted again after their first campaign closed");
  });

  it("reports a member invited through a second people row whose profile shares the member id of a contacted row", async () => {
    const scenario = smallScenario({
      members: 0,
      extra: (context) => {
        const member = synthetic(311, { acceptsAfterHours: 5 });
        // The old row: same member id, contacted before the run under a public id that no longer opens.
        context.db
          .insert(people)
          .values({ publicId: "sim-member-311-old", memberId: member.spec.memberId, profileUrl: "https://www.linkedin.com/in/sim-member-311-old/", fullName: member.spec.fullName, firstSeenAt: context.now, contactedAt: context.now })
          .run();
        enrol(context, { campaign: "A", member: member.spec, role: "shared_member_id", firstName: member.firstName, company: member.company });
        const fact = context.facts.members.get(member.spec.publicId);
        if (fact !== undefined) fact.preRunInvites = 1;
      },
    });
    const { result } = await simulate(inviter({ ignoreSuppression: true }), scenario);
    expect(messages(result(5))).toEqual(["sim-member-311 (shared_member_id): invited 2 times over the install's life (1 before the run, 1 by the app)"]);
    const correct = await simulate(inviter(), scenario);
    expect(messages(correct.result(5))).toEqual([]);
  });
});

describe("6. no backlog after downtime", () => {
  const downtime = { from: rome("2027-03-16", 7), to: rome("2027-03-18", 7) };

  it("names the day after the downtime when it carries a backlog, and reports actions without a human gap", async () => {
    const { result } = await simulate(inviter({ catchUpAfterDowntime: true }), smallScenario({ members: 40, downtimes: [downtime] }));
    const found = messages(result(6));
    expect(found.some((message) => message.startsWith("day after downtime 2027-03-18: invites"))).toBe(true);
    expect(found.some((message) => /^two actions \d+\.\d s apart \(minimum 45 s\)$/.test(message))).toBe(true);
    expect(result(6).notes[0]).toMatch(/^day after downtime \(.*\): 2027-03-18 \(a full working day\) invites \d+\/7/);
  });

  it("a stub that only spends today's budget passes, and the full day after the downtime reaches its invite allowance", async () => {
    const { verdict, result } = await simulate(inviter(), smallScenario({ members: 40, downtimes: [downtime] }));
    expect(messages(result(6))).toEqual([]);
    expect(verdict.daysAfterDowntime).toMatchObject([{ day: "2027-03-18", full: true, atLimit: true, invites: 7, allowance: 7 }]);
    expect(verdict.counts.fullDaysAfterDowntimeAtLimit).toBe(1);
  });

  it("reports a full working day after downtime that reaches no limit: the backlog check on it would prove nothing", async () => {
    const { result } = await simulate(idle, smallScenario({ members: 40, downtimes: [downtime] }));
    expect(messages(result(7))).toContain(
      "day after downtime 2027-03-18 was a full working day but reached neither its invite allowance nor its message limit, so the backlog check on it proves nothing",
    );
  });

  it("reports a stub whose break count starts from zero after a restart, when a burst of kills lands in a long run; one that reads it from the ledger passes", async () => {
    const burst = (): Scenario =>
      smallScenario({
        members: 30,
        days: 1,
        kills: { ...NO_KILLS, forced: [{ kind: "burst", count: 3, runAtLeast: 8, restartMs: [2_000, 6_000] }] },
        extra: (context) => applySettings(context, { warmUp: { enabled: false }, limits: { invitesPerDay: 30 } }),
      });
    const { run, result } = await simulate(inviter({ breakCountResetsOnRestart: true }), burst());
    expect(run.kills.map((kill) => kill.cause)).toEqual(["burst", "burst", "burst"]);
    const [first, , last] = run.kills;
    expect((last?.at.getTime() ?? 0) - (first?.at.getTime() ?? 0)).toBeLessThan(20_000);
    expect(messages(result(6))).toEqual(["18 pieces of work in a row without a break of 10 min or more (at most 15), counted across kills and restarts"]);
    const correct = await simulate(inviter(), burst());
    expect(messages(correct.result(6))).toEqual([]);
    expect(correct.verdict.counts.killsInBurst).toBe(3);
    expect(correct.verdict.counts.longestRunWithoutBreak).toBe(10);
  });

  it("reports a stub that keeps the budgets and the gap but never takes a break; one that breaks every 10 pieces passes", async () => {
    // 30 invites a day are allowed, so the day holds more pieces of work than one run may.
    const busy = () => smallScenario({ members: 30, days: 1, extra: (context) => applySettings(context, { warmUp: { enabled: false }, limits: { invitesPerDay: 30 } }) });
    const { verdict, result } = await simulate(inviter({ noBreaks: true }), busy());
    expect(messages(result(6))).toEqual(["30 pieces of work in a row without a break of 10 min or more (at most 15), counted across kills and restarts"]);
    expect(messages(result(2))).toEqual([]);
    expect(verdict.counts.longestRunWithoutBreak).toBe(30);
    const correct = await simulate(inviter(), busy());
    expect(messages(correct.result(6))).toEqual([]);
    expect(correct.verdict.counts.invites).toBe(30);
    expect(correct.verdict.counts.longestRunWithoutBreak).toBe(10);
    expect(correct.result(6).title).toContain("a break of at least 10 min within every 15 pieces of work over the whole run, kills and restarts included (downtime and nights are breaks)");
  });
});

describe("7. it actually ran", () => {
  it("a dead engine fails the three-week scenario's minimums and leaves approved prospects stuck", async () => {
    const { result } = await simulate(idle, threeWeekScenario(1));
    const found = messages(result(7));
    expect(found).toContain(`too few invites: 0, need at least ${THREE_WEEK_MINIMUMS.invites}`);
    expect(found).toContain(`too few firstMessages: 0, need at least ${THREE_WEEK_MINIMUMS.firstMessages}`);
    expect(found).toContain("too few killsTyped: 0, need at least 1");
    expect(found.some((message) => /^prospect \d+ \(sim-member-\d+\) sits in approved, due .*, while its campaign ran and budgets had room$/.test(message))).toBe(true);
  }, 20_000);
});

describe("7. scripted paths, and nothing silently stuck", () => {
  it("reports an unnamed member greeted with the title in their full name; a stub that holds them passes", async () => {
    const scenario = () =>
      smallScenario({ members: 0, extra: (context) => acceptedConnection(context, 231, {}, { unnamed: true, expect: { kind: "never_greeted" } }) });
    const { result } = await simulate(messenger({ nameFromFullName: true }), scenario());
    expect(messages(result(7))).toEqual(
      expect.arrayContaining([
        "sim-member-231: the app sent a message with a title for a name, an empty greeting or a placeholder",
        "sim-member-231 (accepted): has no first name, yet a message reached them",
        "sim-member-231 (accepted): has no first name and ends message_sent, not in needs review",
      ]),
    );
    const correct = await simulate(messenger(), scenario());
    expect(messages(correct.result(7))).toEqual([]);
  });

  it("reports a follow-up sent in a campaign with none, and a reply there that does not end the sequence as replied", async () => {
    const scenario = smallScenario({
      members: 0,
      extra: (context) => {
        createCampaign(context, TEMPLATES.B);
        acceptedConnection(context, 241, { repliesAfterHours: 2 }, { campaign: "B", expect: { kind: "stops_on_reply" } });
      },
    });
    const { result } = await simulate(messenger({ followUpAlways: true }), scenario);
    expect(messages(result(7))).toEqual(
      expect.arrayContaining([
        "sim-member-241 (accepted): 2 messages in a campaign with no follow-up (one at most)",
        "sim-member-241 (accepted): replied after the first message and ends completed, not stopped (replied)",
      ]),
    );
  });

  it("reports a read row left unknown, and an unknown step row unless its prospect is in needs review", async () => {
    const scenario = smallScenario({
      members: 0,
      extra: (context) => {
        const [held, open] = [251, 252].map((n) => {
          const member = synthetic(n, { acceptsAfterHours: 5 });
          return enrol(context, { campaign: "A", member: member.spec, role: "regular", firstName: member.firstName, company: member.company });
        });
        if (held === undefined || open === undefined) throw new Error("no prospects");
        context.db.update(prospects).set({ stage: "needs_review" }).where(eq(prospects.id, held)).run();
        const unknown = (type: "thread_check" | "invite", prospectId: number) =>
          context.db.insert(actions).values({ type, prospectId, status: "unknown", idempotencyKey: `${type}:${prospectId}`, attempts: 1, startedAt: context.now }).run();
        unknown("thread_check", held);
        unknown("invite", held);
        unknown("invite", open);
      },
    });
    const found = messages((await simulate(idle, scenario)).result(7)).filter((message) => message.includes(" row "));
    expect(found).toEqual([
      "read row thread_check:1 is still unknown at the end (a read ends done or failed, never unknown)",
      "step row invite:2 is still unknown at the end and its prospect is approved (a step may stay unknown only while its prospect is in needs review)",
    ]);
  });
});

describe("7. changes the user makes in the app while a tick runs", () => {
  const midTick = (): Scenario => ({
    ...smallScenario({
      members: 0,
      extra: (context) => {
        scriptedMember(context, 281, { kind: "paused_mid_read" });
        scriptedMember(context, 282, { kind: "changed_mid_tick", to: "rejected" });
      },
    }),
    interventions: [pauseMidRead("sim-member-281", "A", 2 * HOUR_MS, "viewProfile"), closeMidRead("sim-member-282", "viewProfile", "rejected")],
  });

  it("reports sends to a prospect whose campaign was paused, or who was rejected, while its profile loaded", async () => {
    const { run, result } = await simulate(inviter({ noRecheckBeforeClaim: true }), midTick());
    expect(run.interventions.map((record) => `${record.target} ${record.phase}`)).toEqual(["sim-member-281 fired", "sim-member-281 later", "sim-member-282 fired"]);
    expect(messages(result(7))).toEqual(
      expect.arrayContaining([
        "sim-member-281 (scripted): reached by the app while their campaign was paused",
        "sim-member-281 (scripted): not worked again after their campaign resumed (ends invited)",
        "sim-member-282 (scripted): 1 send(s) reached them after the user rejected the prospect mid-tick",
        "sim-member-282 (scripted): the user rejected the prospect mid-tick and it ends invited",
      ]),
    );
  });

  it("a stub that looks again before it claims passes: no hold, the paused prospect is invited after the resume", async () => {
    const { run, verdict, result } = await simulate(inviter(), midTick());
    expect(messages(result(7))).toEqual([]);
    expect(verdict.counts.changesMidTick).toBe(2);
    const resumed = run.interventions.find((record) => record.phase === "later")?.at.getTime() ?? Number.NaN;
    expect(run.world.invitesTo("sim-member-281").map((entry) => entry.at.getTime() > resumed)).toEqual([true]);
    expect(run.world.invitesTo("sim-member-282")).toEqual([]);
  });
});

describe("8. the ledger agrees with LinkedIn", () => {
  it("reports invites LinkedIn received that the ledger does not hold", async () => {
    const { result } = await simulate(inviter({ noLedger: true }), smallScenario({ members: 3, days: 1 }));
    expect(messages(result(8))).toContain("LinkedIn got a invite for sim-member-001 with no done invite row in the ledger");
  });

  it("reports done ledger rows LinkedIn never received", async () => {
    const { result } = await simulate(inviter({ phantomLedger: true }), smallScenario({ members: 3, days: 1 }));
    expect(messages(result(8))).toContain("ledger row invite:1 is done but LinkedIn shows 0 invite");
  });

  it("reports two done rows that rest on one invitation", async () => {
    const { result } = await simulate(inviter({ doubleLedger: true }), smallScenario({ members: 3, days: 1 }));
    expect(messages(result(8))).toContain("the ledger holds 2 done invite rows for sim-member-001 but LinkedIn received 1");
  });

  it("is quiet for an inviter that records each invitation once", async () => {
    const { result } = await simulate(inviter(), smallScenario({ members: 3, days: 1 }));
    expect(messages(result(8))).toEqual([]);
  });
});
