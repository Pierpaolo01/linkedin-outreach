import { isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { safetyStops } from "../../db/schema";
import { LinkedInError } from "../../linkedin/errors";
import type { EngineModule } from "./harness";
import { mulberry32, VirtualClock } from "./harness";
import { enrol, rome, synthetic } from "./scenario";
import { inviter, messenger, smallScenario } from "./stubs";
import { acceptedConnection, messages, simulate } from "./testing";

describe("seeded randomness and the virtual clock", () => {
  it("mulberry32 repeats a sequence for a seed and differs for another", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("sleep jumps the clock without waiting, and advanceTo never goes back", async () => {
    const clock = new VirtualClock(new Date("2027-03-15T07:00:00Z"));
    await clock.sleep(3 * 86_400_000);
    expect(clock.now().toISOString()).toBe("2027-03-18T07:00:00.000Z");
    clock.advanceTo(new Date("2027-03-01T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2027-03-18T07:00:00.000Z");
  });
});

describe("the run loop", () => {
  it("replays a seed exactly, kills included", async () => {
    const scenario = () => smallScenario({ members: 12, kills: { sendPoint: 0.2, readPoint: 0.1, betweenTicks: 0.05, reconcileRead: 0.5, quickRekill: 0.2, ensureAfter: null } });
    const first = await simulate(inviter(), scenario(), 7);
    const second = await simulate(inviter(), scenario(), 7);
    expect(first.run.kills.length).toBeGreaterThan(0);
    expect(JSON.stringify(second.run.world.log)).toBe(JSON.stringify(first.run.world.log));
    expect(JSON.stringify(second.run.kills)).toBe(JSON.stringify(first.run.kills));
  });

  it("runs no tick at all while the laptop is off, and starts a new process afterwards", async () => {
    const downtime = { from: rome("2027-03-16", 7), to: rome("2027-03-18", 7) };
    const { run } = await simulate(inviter(), smallScenario({ members: 30, downtimes: [downtime] }));
    expect(run.world.log.filter((entry) => entry.at > downtime.from && entry.at < downtime.to)).toEqual([]);
    expect(run.world.log.some((entry) => entry.at > downtime.to)).toBe(true);
    expect(run.kills.filter((kill) => kill.cause === "downtime")).toHaveLength(1);
  });
});

describe("kills", () => {
  it("delivers every kind of kill, each one lands, and the stub's work survives them", async () => {
    const { run, verdict, result } = await simulate(
      inviter(),
      smallScenario({ members: 25, kills: { sendPoint: 0.05, readPoint: 0.02, betweenTicks: 0.01, reconcileRead: 0, quickRekill: 0, ensureAfter: 0 } }),
      3,
    );
    const phases = new Set(run.kills.map((kill) => kill.phase));
    expect(phases).toEqual(new Set(["before", "after", "between"]));
    expect(run.kills.some((kill) => kill.duringReconcileRead)).toBe(true);
    expect(run.kills.some((kill) => kill.beforeTickCompleted)).toBe(true);
    expect(run.kills.every((kill) => kill.verified === "rejected" || kill.verified === "revoked")).toBe(true);
    expect(run.finishedAt.getTime()).toBeGreaterThanOrEqual(run.scenario.end.getTime());
    expect(verdict.counts.reconcileConfirmedSent + verdict.counts.reconcileRetried).toBeGreaterThan(0);
    for (const id of [0, 1, 5, 8]) expect(messages(result(id))).toEqual([]);
  });

  it("a kill with the text typed but not sent leaves nothing glued to the message sent after the restart", async () => {
    const scenario = smallScenario({
      members: 0,
      kills: { sendPoint: 0, readPoint: 0, betweenTicks: 0, reconcileRead: 0, quickRekill: 0, ensureAfter: null, forced: [{ kind: "nth", op: "sendMessage", phase: "typed", nth: 1 }] },
      extra: (context) => [201, 202].forEach((n) => acceptedConnection(context, n)),
    });
    const { run, result } = await simulate(messenger(), scenario);
    expect(run.kills).toMatchObject([{ op: "sendMessage", phase: "typed", verified: "rejected" }]);
    expect(run.world.log.filter((entry) => entry.kind === "message")).toHaveLength(2);
    expect(messages(result(1))).toEqual([]);
  });

  it("an engine that swallows a kill is reported as a harness failure", async () => {
    const scenario = smallScenario({
      members: 3,
      kills: { sendPoint: 0, readPoint: 0, betweenTicks: 0, reconcileRead: 0, quickRekill: 0, ensureAfter: null, forced: [{ kind: "nth", op: "sendInvite", phase: "after", nth: 1 }] },
    });
    const { run, result } = await simulate(inviter({ swallowErrors: true }), scenario);
    expect(run.kills[0]?.verified).toBe("swallowed");
    expect(messages(result(0)).join("\n")).toMatch(/swallowed a kill at sendInvite\/after/);
  });
});

describe("scripted members", () => {
  it("get exactly the forced kills aimed at them, in order, and no random kill or scripted fault", async () => {
    const [aimed, spared] = ["sim-member-261", "sim-member-262"];
    const base = smallScenario({
      members: 6,
      kills: {
        sendPoint: 0.2,
        readPoint: 0.1,
        betweenTicks: 0,
        reconcileRead: 0.5,
        quickRekill: 0.2,
        ensureAfter: null,
        forced: [
          { kind: "member", op: "sendInvite", phase: "after", target: aimed ?? "" },
          { kind: "rekill", target: aimed ?? "" },
          { kind: "reconcile_read", target: aimed ?? "" },
        ],
      },
      extra: (context) => {
        for (const n of [261, 262]) {
          const member = synthetic(n, { acceptsAfterHours: 5 });
          enrol(context, { campaign: "A", member: member.spec, role: "scripted", firstName: member.firstName, company: member.company, scripted: true });
        }
      },
    });
    // A fault every half hour of the first two days, on the two calls every invite makes.
    const faults = Array.from({ length: 96 }, (_, index) => ({
      at: new Date(rome("2027-03-15", 9).getTime() + index * 30 * 60_000),
      op: index % 2 === 0 ? ("viewProfile" as const) : ("sendInvite" as const),
      fault: "timeout_before_effect" as const,
    }));
    const { run } = await simulate(inviter(), { ...base, faults });
    const onAimed = run.kills.filter((kill) => kill.target === aimed);
    expect(onAimed.filter((kill) => kill.cause === "forced").map((kill) => `${kill.op ?? "-"}/${kill.phase} reconcile=${String(kill.duringReconcileRead)}`)).toEqual([
      "sendInvite/after reconcile=false",
      "viewProfile/before reconcile=true",
    ]);
    // The process started right after the kill on the aimed member dies at its first kill point, whoever it is about.
    const first = onAimed[0];
    const afterAimed = first === undefined ? undefined : run.kills[run.kills.indexOf(first) + 1];
    expect(afterAimed).toMatchObject({ cause: "rekill", beforeTickCompleted: true });
    expect(run.kills.filter((kill) => kill.target === spared)).toEqual([]);
    expect(run.kills.some((kill) => kill.cause === "random")).toBe(true);
    const uncertain = run.uncertainSends.filter((send) => send.via.startsWith("timeout"));
    expect(uncertain.length).toBeGreaterThan(0);
    expect(uncertain.filter((send) => send.publicId === aimed || send.publicId === spared)).toEqual([]);
    expect(run.world.invitesTo(spared ?? "")).toHaveLength(1);
  });
});

describe("safety stops", () => {
  it("the user fixes the session, presses Resume, and the app carries on with a fresh driver handle", async () => {
    // The inviter, plus: a checkpoint raises a stop; while a stop is active it does nothing.
    const base = inviter();
    const stopping: EngineModule = {
      createEngine: (deps) => {
        const inner = base.createEngine(deps);
        return {
          async tick() {
            const now = deps.clock.now();
            if (deps.db.select().from(safetyStops).where(isNull(safetyStops.resumedAt)).get() !== undefined) {
              return { did: null, wakeAt: new Date(now.getTime() + 600_000) };
            }
            try {
              return await inner.tick();
            } catch (error) {
              if (!(error instanceof LinkedInError) || error.kind !== "checkpoint") throw error;
              deps.db.insert(safetyStops).values({ reason: "checkpoint", raisedAt: deps.clock.now() }).run();
              return { did: "safety stop", wakeAt: new Date(deps.clock.now().getTime() + 600_000) };
            }
          },
        };
      },
      resumeSafetyStop: (db, now) => db.update(safetyStops).set({ resumedAt: now }).where(isNull(safetyStops.resumedAt)).run().changes > 0,
    };
    const breakAt = rome("2027-03-16", 10);
    const scenario = { ...smallScenario({ members: 30 }), sessionBreaks: [{ at: breakAt, kind: "checkpoint" as const, userFixesBy: rome("2027-03-17", 10) }] };
    const { run } = await simulate(stopping, scenario);
    expect(run.userResumes).toHaveLength(1);
    const resume = run.userResumes[0];
    expect(resume).toMatchObject({ resumed: true, reasons: ["checkpoint"] });
    const resumedAt = resume?.at ?? new Date(0);
    expect(resumedAt.getTime() - breakAt.getTime()).toBeGreaterThan(2 * 3_600_000);
    expect(run.world.log.some((entry) => entry.kind === "invite" && entry.at > resumedAt)).toBe(true);
    expect(run.world.log.some((entry) => entry.kind === "invite" && entry.at > breakAt && entry.at < resumedAt)).toBe(false);
  });
});
