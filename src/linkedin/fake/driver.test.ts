import { describe, expect, it } from "vitest";
import { Checkpoint, LimitHit, LoggedOut, Restricted, SearchCapped, Unexpected } from "../errors";
import { FakeWorld, HandleRevoked, type KillHook, type KillPoint, type MemberSpec } from "./world";

const START = new Date("2026-11-16T09:00:00Z");

function virtualClock(start: Date = START) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const connection: MemberSpec = {
  publicId: "test-person-1",
  memberId: "ACoATestPerson1",
  fullName: "Test Person 1",
  degree: 1,
};
const stranger: MemberSpec = { publicId: "test-person-2", memberId: "ACoATestPerson2", fullName: "Test Person 2", degree: 2 };
const ref1 = { publicId: "test-person-1", memberId: "ACoATestPerson1" };
const ref2 = { publicId: "test-person-2", memberId: "ACoATestPerson2" };

function setup(hook?: KillHook, random: () => number = () => 0.5) {
  const clock = virtualClock();
  const world = new FakeWorld({ start: START });
  world.addMember(connection);
  world.addMember(stranger);
  const handle = world.connect({ clock, random, ...(hook === undefined ? {} : { hook }) });
  return { clock, world, ...handle };
}

class Killed extends Error {}

/** A hook that throws `Killed` at one kill point and records every point it saw. */
function killAt(target: KillPoint) {
  const seen: KillPoint[] = [];
  const killed = new Killed(`killed at ${target.op}/${target.phase}`);
  const hook: KillHook = (point) => {
    seen.push(point);
    if (point.op === target.op && point.phase === target.phase) throw killed;
  };
  return { seen, killed, hook };
}

describe("simulated time", () => {
  it("every operation sleeps 2 to 20 seconds on the injected clock", async () => {
    for (const [random, expected] of [
      [0, 2_000],
      [0.999_999, 20_000],
    ] as const) {
      const { clock, driver } = setup(undefined, () => random);
      await driver.ensureSession();
      expect(clock.now().getTime() - START.getTime()).toBe(expected);
    }
  });
});

describe("kill points", () => {
  it("sendMessage passes before, typed and after, in order; a read passes before and after", async () => {
    const { seen, hook } = killAt({ op: "ensureSession", phase: "typed" });
    const { driver } = setup(hook);
    await driver.sendMessage(ref1, "Hello");
    await driver.viewProfile("test-person-2");
    expect(seen).toEqual([
      { op: "sendMessage", phase: "before" },
      { op: "sendMessage", phase: "typed" },
      { op: "sendMessage", phase: "after" },
      { op: "viewProfile", phase: "before" },
      { op: "viewProfile", phase: "after" },
    ]);
  });

  it("killed before: nothing happened, and the hook's error propagates unchanged", async () => {
    const { killed, hook } = killAt({ op: "sendMessage", phase: "before" });
    const { world, driver } = setup(hook);
    await expect(driver.sendMessage(ref1, "Hello")).rejects.toBe(killed);
    expect(world.log).toEqual([]);
    expect(world.draft("test-person-1")).toBeNull();
    expect(world.thread("test-person-1")).toEqual([]);
  });

  it("killed when typed: the draft is in the box and no message was sent", async () => {
    const { killed, hook } = killAt({ op: "sendMessage", phase: "typed" });
    const { world, driver } = setup(hook);
    await expect(driver.sendMessage(ref1, "Hello")).rejects.toBe(killed);
    expect(world.draft("test-person-1")).toBe("Hello");
    expect(world.thread("test-person-1")).toEqual([]);
    expect(world.messagesSentTo("test-person-1")).toEqual([]);
  });

  it("killed after: the message is in the thread and the log", async () => {
    const { killed, hook } = killAt({ op: "sendMessage", phase: "after" });
    const { world, driver } = setup(hook);
    await expect(driver.sendMessage(ref1, "Hello")).rejects.toBe(killed);
    expect(world.thread("test-person-1")).toMatchObject([{ sender: "user", source: "app", text: "Hello" }]);
    expect(world.messagesSentTo("test-person-1")).toMatchObject([{ kind: "message", text: "Hello" }]);
    expect(world.draft("test-person-1")).toBeNull();
  });

  it("killed after an invite: the invite was sent", async () => {
    const { killed, hook } = killAt({ op: "sendInvite", phase: "after" });
    const { world, driver } = setup(hook);
    await expect(driver.sendInvite(ref2, null)).rejects.toBe(killed);
    expect(world.invitesTo("test-person-2")).toHaveLength(1);
  });

  it("a draft left by a killed send is cleared before the next send: no stale text is glued on", async () => {
    const { killed, hook } = killAt({ op: "sendMessage", phase: "typed" });
    const first = setup(hook);
    await expect(first.driver.sendMessage(ref1, "Old text")).rejects.toBe(killed);
    expect(first.world.draft("test-person-1")).toBe("Old text");

    const { driver } = first.world.connect({ clock: first.clock, random: () => 0.5 });
    await driver.sendMessage(ref1, "New text");
    expect(first.world.thread("test-person-1").map((message) => message.text)).toEqual(["New text"]);
    expect(first.world.messagesSentTo("test-person-1").map((entry) => entry.text)).toEqual(["New text"]);
    expect(first.world.draft("test-person-1")).toBeNull();
  });
});

describe("revoke", () => {
  it("a call in flight throws at its next step and has no effect", async () => {
    const { world, driver, revoke } = setup();
    const pending = driver.sendInvite(ref2, null);
    revoke();
    await expect(pending).rejects.toBeInstanceOf(HandleRevoked);
    expect(world.log).toEqual([]);
    expect(world.status("test-person-2").pendingSince).toBeNull();
  });

  it("revoked while typed: the draft stays and nothing is sent", async () => {
    let revokeHandle = () => {};
    const { world, driver, revoke } = setup((point) => {
      if (point.phase === "typed") revokeHandle();
    });
    revokeHandle = revoke;
    await expect(driver.sendMessage(ref1, "Hello")).rejects.toBeInstanceOf(HandleRevoked);
    expect(world.draft("test-person-1")).toBe("Hello");
    expect(world.messagesSentTo("test-person-1")).toEqual([]);
  });

  it("every later call on a revoked handle throws without touching the world; a new handle works", async () => {
    const { clock, world, driver, revoke } = setup();
    revoke();
    await expect(driver.ensureSession()).rejects.toBeInstanceOf(HandleRevoked);
    await expect(driver.sendMessage(ref1, "Hello")).rejects.toBeInstanceOf(HandleRevoked);
    expect(world.log).toEqual([]);
    expect(clock.now()).toEqual(START);
    const fresh = world.connect({ clock, random: () => 0.5 });
    await fresh.driver.sendMessage(ref1, "Hello");
    expect(world.messagesSentTo("test-person-1")).toHaveLength(1);
  });
});

describe("scripted faults", () => {
  it("unexpected: throws Unexpected and nothing happens", async () => {
    const { world, driver } = setup();
    world.failNext("sendInvite", "unexpected");
    await expect(driver.sendInvite(ref2, null)).rejects.toBeInstanceOf(Unexpected);
    expect(world.invitesTo("test-person-2")).toEqual([]);
    expect(await driver.sendInvite(ref2, null)).toBe("sent");
  });

  it("timeout before effect: throws a plain Error and nothing happens", async () => {
    const { world, driver } = setup();
    world.failNext("sendMessage", "timeout_before_effect");
    const error: unknown = await driver.sendMessage(ref1, "Hello").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("kind");
    expect(world.thread("test-person-1")).toEqual([]);
    expect(world.draft("test-person-1")).toBeNull();
  });

  it("timeout after effect: the effect happened and was logged, then a plain Error is thrown", async () => {
    const { world, driver } = setup();
    world.failNext("sendInvite", "timeout_after_effect");
    world.failNext("sendMessage", "timeout_after_effect");
    const inviteError: unknown = await driver.sendInvite(ref2, "Hi").catch((thrown: unknown) => thrown);
    const messageError: unknown = await driver.sendMessage(ref1, "Hello").catch((thrown: unknown) => thrown);
    for (const error of [inviteError, messageError]) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("kind");
    }
    expect(world.invitesTo("test-person-2")).toMatchObject([{ note: "Hi" }]);
    expect(world.status("test-person-2").pendingSince).not.toBeNull();
    expect(world.messagesSentTo("test-person-1")).toMatchObject([{ text: "Hello" }]);
    expect(world.thread("test-person-1")).toHaveLength(1);
  });

  it("search capped: throws SearchCapped, does not latch, and queues per operation in order", async () => {
    const { world, driver } = setup();
    world.failNext("searchPeople", "search_capped");
    world.failNext("searchPeople", "unexpected");
    await expect(driver.searchPeople({ keywords: "tester" })).rejects.toBeInstanceOf(SearchCapped);
    await expect(driver.searchPeople({ keywords: "tester" })).rejects.toBeInstanceOf(Unexpected);
    expect(await driver.searchPeople({ keywords: "tester" })).toMatchObject({ cards: [], capped: false });
  });
});

describe("session and safety stops", () => {
  it.each([
    ["logged_out", LoggedOut],
    ["checkpoint", Checkpoint],
    ["restricted", Restricted],
  ] as const)("a %s session makes calls throw the matching error and latches the handle", async (kind, ErrorType) => {
    const { clock, world, driver } = setup();
    world.breakSession(kind);
    const error: unknown = await driver.sendMessage(ref1, "Hello").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ErrorType);
    expect(world.thread("test-person-1")).toEqual([]);

    world.fixSession();
    const logged = world.log.length;
    const time = clock.now().getTime();
    await expect(driver.ensureSession()).rejects.toBe(error);
    await expect(driver.sendInvite(ref2, null)).rejects.toBe(error);
    expect(world.log).toHaveLength(logged);
    expect(clock.now().getTime()).toBe(time);

    const fresh = world.connect({ clock, random: () => 0.5 }).driver;
    expect(await fresh.ensureSession()).toMatchObject({ state: "ok" });
  });

  it("every call throws while the session is broken, on every new handle", async () => {
    const { clock, world } = setup();
    world.breakSession("checkpoint");
    for (let k = 0; k < 2; k += 1) {
      const { driver } = world.connect({ clock, random: () => 0.5 });
      await expect(driver.viewProfile("test-person-2")).rejects.toBeInstanceOf(Checkpoint);
    }
    expect(world.log.filter((entry) => entry.kind === "profile_view")).toEqual([]);
  });

  it("LinkedIn's invitation limit latches the handle too", async () => {
    const clock = virtualClock();
    const world = new FakeWorld({ start: START, weeklyInviteCap: 0 });
    world.addMember(stranger);
    const { driver } = world.connect({ clock, random: () => 0.5 });
    const error: unknown = await driver.sendInvite(ref2, null).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LimitHit);
    await expect(driver.viewProfile("test-person-2")).rejects.toBe(error);
    expect(world.log.filter((entry) => entry.kind === "profile_view")).toEqual([]);
  });

  it("an unexpected page does not latch", async () => {
    const { world, driver } = setup();
    await expect(driver.readThread(ref2)).rejects.toBeInstanceOf(Unexpected);
    expect(await driver.viewProfile("test-person-2")).toMatchObject({ publicId: "test-person-2" });
    expect(world.log.at(-1)).toMatchObject({ kind: "profile_view" });
  });
});
