import { describe, expect, it } from "vitest";
import { LimitHit, Unexpected } from "../errors";
import { FakeWorld, type MemberSpec, type WorldOptions } from "./world";

/** Monday 2026-11-16, 09:00 UTC. */
const START = new Date("2026-11-16T09:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** With `random` fixed at 0.5 every driver call takes 2 s + floor(0.5 × 18 001) ms. */
const STEP = 11_000;

function virtualClock(start: Date = START) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}

function person(i: number, extra: Partial<MemberSpec> = {}): MemberSpec {
  return {
    publicId: `test-person-${i}`,
    memberId: `ACoATestPerson${i}`,
    fullName: `Test Person ${i}`,
    headline: "Tester at Example Co",
    degree: 2,
    ...extra,
  };
}

function ref(i: number) {
  return { publicId: `test-person-${i}`, memberId: `ACoATestPerson${i}` };
}

function setup(members: readonly MemberSpec[] = [], options: Omit<WorldOptions, "start"> = {}) {
  const clock = virtualClock();
  const world = new FakeWorld({ start: START, ...options });
  members.forEach((member) => world.addMember(member));
  const { driver } = world.connect({ clock, random: () => 0.5 });
  return { clock, world, driver };
}

/** Invites person `i` with `note` and moves the clock past their acceptance. Returns the acceptance time. */
async function inviteAndAccept(env: ReturnType<typeof setup>, i: number, note: string | null): Promise<Date> {
  expect(await env.driver.sendInvite(ref(i), note)).toBe("sent");
  env.clock.advance(DAY);
  await env.driver.listRecentConnections();
  const connectedAt = env.world.status(`test-person-${i}`).connectedAt;
  if (connectedAt === null) throw new Error("not accepted");
  return connectedAt;
}

describe("viewProfile", () => {
  it("shows where the invite step stands for each kind of member, with the member id", async () => {
    const { driver } = setup([
      person(1),
      person(2, { connectInMore: true }),
      person(3, { invitedOutsideApp: true }),
      person(4, { degree: 1 }),
      person(5, { connectUnavailable: true, degree: 3 }),
    ]);
    const states = [];
    for (const i of [1, 2, 3, 4, 5]) {
      const profile = await driver.viewProfile(`test-person-${i}`);
      states.push([profile.connectionState, profile.degree, profile.memberId, profile.messageAvailable]);
    }
    expect(states).toEqual([
      ["can_connect", 2, "ACoATestPerson1", false],
      ["connect_in_more", 2, "ACoATestPerson2", false],
      ["pending", 2, "ACoATestPerson3", false],
      ["connected", 1, "ACoATestPerson4", true],
      ["follow_only", 3, "ACoATestPerson5", false],
    ]);
  });

  it("throws Unexpected for a profile that does not exist", async () => {
    const { driver } = setup();
    await expect(driver.viewProfile("nobody-here")).rejects.toBeInstanceOf(Unexpected);
  });

  it("logs a profile view at the world time it happened", async () => {
    const { clock, world, driver } = setup([person(1)]);
    await driver.viewProfile("test-person-1");
    expect(world.log).toEqual([{ kind: "profile_view", publicId: "test-person-1", memberId: "ACoATestPerson1", at: clock.now() }]);
  });
});

describe("sendInvite", () => {
  it("sends once and logs the invite with its note", async () => {
    const { world, driver } = setup([person(1)]);
    expect(await driver.sendInvite(ref(1), "Hello there")).toBe("sent");
    expect(world.invitesTo("test-person-1")).toEqual([
      { kind: "invite", publicId: "test-person-1", memberId: "ACoATestPerson1", note: "Hello there", at: new Date(START.getTime() + STEP) },
    ]);
    expect(world.status("test-person-1").pendingSince).toEqual(new Date(START.getTime() + STEP));
  });

  it("refuses without sending: already pending, already connected, not offered", async () => {
    const { world, driver } = setup([
      person(1, { invitedOutsideApp: true }),
      person(2, { degree: 1 }),
      person(3, { connectUnavailable: true }),
    ]);
    expect(await driver.sendInvite(ref(1), null)).toBe("already_pending");
    expect(await driver.sendInvite(ref(2), null)).toBe("already_connected");
    expect(await driver.sendInvite(ref(3), null)).toBe("not_offered");
    expect(world.log.filter((entry) => entry.kind === "invite")).toEqual([]);
  });

  it("a second invite to the same person finds it pending", async () => {
    const { world, driver } = setup([person(1)]);
    await driver.sendInvite(ref(1), null);
    expect(await driver.sendInvite(ref(1), null)).toBe("already_pending");
    expect(world.invitesTo("test-person-1")).toHaveLength(1);
  });

  it("throws Unexpected and sends nothing for a note over 300 UTF-16 units; 300 fits", async () => {
    const { world, driver } = setup([person(1), person(2)]);
    await expect(driver.sendInvite(ref(1), "é".repeat(150) + "😀".repeat(1) + "x".repeat(149))).rejects.toBeInstanceOf(Unexpected);
    expect(world.invitesTo("test-person-1")).toEqual([]);
    expect(await driver.sendInvite(ref(2), "x".repeat(300))).toBe("sent");
  });

  it("over the weekly cap throws LimitHit and sends nothing; a week later it sends again", async () => {
    const { world, driver } = setup([person(1), person(2), person(3)], { weeklyInviteCap: 2 });
    await driver.sendInvite(ref(1), null);
    await driver.sendInvite(ref(2), null);
    await expect(driver.sendInvite(ref(3), null)).rejects.toBeInstanceOf(LimitHit);
    expect(world.log.filter((entry) => entry.kind === "invite")).toHaveLength(2);
    expect(world.status("test-person-3").pendingSince).toBeNull();

    const later = virtualClock(new Date(START.getTime() + 7 * DAY + MINUTE));
    const fresh = world.connect({ clock: later, random: () => 0.5 }).driver;
    expect(await fresh.sendInvite(ref(3), null)).toBe("sent");
  });

  it("counts an invitation sent outside the app against the weekly cap until a week after it was sent", async () => {
    const { world, driver } = setup([person(1, { invitedOutsideApp: true, invitedAt: START }), person(2)], { weeklyInviteCap: 1 });
    await expect(driver.sendInvite(ref(2), null)).rejects.toBeInstanceOf(LimitHit);
    // It is LinkedIn's count, not the app's: the log of what the app sent stays empty.
    expect(world.log.filter((entry) => entry.kind === "invite")).toEqual([]);

    const later = virtualClock(new Date(START.getTime() + 7 * DAY + MINUTE));
    const fresh = world.connect({ clock: later, random: () => 0.5 }).driver;
    expect(await fresh.sendInvite(ref(2), null)).toBe("sent");
  });
});

describe("acceptance", () => {
  it("becomes visible only once its time has come", async () => {
    const { clock, world, driver } = setup([person(1, { acceptsAfterHours: 5 })]);
    await driver.sendInvite(ref(1), null);
    const sentAt = clock.now().getTime();

    clock.advance(5 * HOUR - 3 * STEP);
    expect(await driver.listRecentConnections()).toEqual([]);
    expect((await driver.viewProfile("test-person-1")).connectionState).toBe("pending");
    // The next call reads the page exactly at the acceptance time.

    expect(await driver.listRecentConnections()).toMatchObject([
      { publicId: "test-person-1", memberId: "ACoATestPerson1", degree: 1, connectedOn: "2026-11-16", connectedOnText: "Connected on November 16, 2026" },
    ]);
    expect(world.status("test-person-1")).toEqual({ degree: 1, connectedAt: new Date(sentAt + 5 * HOUR), pendingSince: null });
    expect((await driver.viewProfile("test-person-1")).connectionState).toBe("connected");
  });

  it("never comes for a member who never accepts", async () => {
    const { clock, driver } = setup([person(1, { acceptsAfterHours: null })]);
    await driver.sendInvite(ref(1), null);
    clock.advance(60 * DAY);
    expect(await driver.listRecentConnections()).toEqual([]);
  });

  it("shows the invite note as the user's first message", async () => {
    const env = setup([person(1, { acceptsAfterHours: 2 })]);
    const connectedAt = await inviteAndAccept(env, 1, "Hi Test Person 1, nice to meet you !");
    const thread = await env.driver.readThread(ref(1));
    expect(thread.isNew).toBe(false);
    expect(thread.messages).toMatchObject([{ sender: "user", senderName: "Test User", text: "Hi Test Person 1, nice to meet you !" }]);
    expect(env.world.thread("test-person-1")).toEqual([
      { sender: "user", source: "note", text: "Hi Test Person 1, nice to meet you !", at: connectedAt },
    ]);
    expect(env.world.messagesSentTo("test-person-1")).toEqual([]);
  });

  it("with notes as first message turned off, the conversation is new", async () => {
    const env = setup([person(1, { acceptsAfterHours: 2 })], { notesAsFirstMessage: false });
    await inviteAndAccept(env, 1, "Hello");
    const thread = await env.driver.readThread(ref(1));
    expect(thread).toMatchObject({ isNew: true, messages: [], viaCompose: true });
  });

  it("does not happen after the invitation was withdrawn", async () => {
    const { clock, world, driver } = setup([person(1, { acceptsAfterHours: 48 })]);
    await driver.sendInvite(ref(1), null);
    expect(await driver.withdrawInvite(ref(1))).toBe("withdrawn");
    expect(await driver.withdrawInvite(ref(1))).toBe("not_pending");
    clock.advance(10 * DAY);
    expect(await driver.listRecentConnections()).toEqual([]);
    expect(world.log.filter((entry) => entry.kind === "withdraw")).toHaveLength(1);
  });
});

describe("readThread", () => {
  it("is new and empty for a connection nobody has written to, when the public id is given", async () => {
    const { world, driver } = setup([person(1, { degree: 1 })]);
    const thread = await driver.readThread(ref(1));
    expect(thread).toMatchObject({
      isNew: true,
      viaCompose: true,
      messages: [],
      // As the live parser reads LinkedIn's empty "New message" pane.
      kind: "unknown",
      threadUrl: null,
      participant: { fullName: "Test Person 1", publicId: "test-person-1" },
    });
    expect(world.log.at(-1)).toMatchObject({ kind: "thread_read", publicId: "test-person-1" });
  });

  it("throws Unexpected for an empty pane when the public id is missing or someone else's", async () => {
    const { driver } = setup([person(1, { degree: 1 })]);
    await expect(driver.readThread({ memberId: "ACoATestPerson1" })).rejects.toBeInstanceOf(Unexpected);
    await expect(driver.readThread({ memberId: "ACoATestPerson1", publicId: "test-person-9" })).rejects.toBeInstanceOf(Unexpected);
  });

  it("throws Unexpected for anyone who is not a connection (the compose URL is an InMail form)", async () => {
    const { world, driver } = setup([person(1), person(2, { invitedOutsideApp: true })]);
    await expect(driver.readThread(ref(1))).rejects.toBeInstanceOf(Unexpected);
    await expect(driver.readThread(ref(2))).rejects.toBeInstanceOf(Unexpected);
    expect(world.log.filter((entry) => entry.kind === "thread_read")).toEqual([]);
  });

  it("returns the latest 20 messages, oldest first", async () => {
    const { clock, driver } = setup([person(1, { degree: 1 })]);
    for (let n = 1; n <= 22; n += 1) {
      await driver.sendMessage(ref(1), `Message ${n}`, { messageCount: Math.min(n - 1, 20) });
      clock.advance(MINUTE);
    }
    const thread = await driver.readThread(ref(1));
    expect(thread.messages.map((message) => message.text)).toEqual(Array.from({ length: 20 }, (_, k) => `Message ${k + 3}`));
  });

  it("shows times as day headings; only a message from an earlier year has an exact time", async () => {
    const clock = virtualClock(new Date("2025-12-31T15:00:00Z"));
    const world = new FakeWorld({ start: START });
    world.addMember(person(1, { degree: 1 }));
    const { driver } = world.connect({ clock, random: () => 0.5 });
    await driver.sendMessage(ref(1), "Last year", { messageCount: 0 });
    clock.advance(8 * DAY);
    await driver.sendMessage(ref(1), "New year", { messageCount: 1 });
    const messages = (await driver.readThread(ref(1))).messages;
    expect(messages.map((message) => [message.sentAtRaw, message.sentAt])).toEqual([
      ["Dec 31, 2025 3:00 PM", new Date("2025-12-31T15:00:00Z")],
      ["Today 3:00 PM", null],
    ]);
  });

  it("names the participant by member id once they have written, and by nobody when only the user has", async () => {
    const env = setup([person(1, { degree: 1, repliesAfterHours: 1 })]);
    await env.driver.sendMessage(ref(1), "Hello", { messageCount: 0 });
    expect((await env.driver.readThread(ref(1))).participant.publicId).toBeNull();
    env.clock.advance(2 * HOUR);
    expect((await env.driver.readThread(ref(1))).participant.publicId).toBe("ACoATestPerson1");
  });
});

describe("texts as LinkedIn stores them", () => {
  it("trims, turns CRLF into LF, collapses three or more line breaks to two and puts a non-breaking space before ? ! :", async () => {
    const { world, driver } = setup([person(1, { degree: 1 })]);
    await driver.sendMessage(ref(1), "  Hi Test Person 1 !\r\nOne question :\r\n\r\n\r\n\r\nHow are you ?  ", { messageCount: 0 });
    const stored = "Hi Test Person 1 !\nOne question :\n\nHow are you ?";
    expect((await driver.readThread(ref(1))).messages.map((message) => message.text)).toEqual([stored]);
    expect(world.messagesSentTo("test-person-1").map((entry) => entry.text)).toEqual([
      "  Hi Test Person 1 !\r\nOne question :\r\n\r\n\r\n\r\nHow are you ?  ",
    ]);
  });

  it("keeps the space when the non-breaking space option is off", async () => {
    const { driver } = setup([person(1, { degree: 1 })], { nbspBeforePunctuation: false });
    await driver.sendMessage(ref(1), "How are you ?", { messageCount: 0 });
    expect((await driver.readThread(ref(1))).messages.map((message) => message.text)).toEqual(["How are you ?"]);
  });
});

describe("sendMessage", () => {
  it("throws Unexpected and sends nothing to someone who is not a connection", async () => {
    const { world, driver } = setup([person(1), person(2, { invitedOutsideApp: true })]);
    await expect(driver.sendMessage(ref(1), "Hello", { messageCount: 0 })).rejects.toBeInstanceOf(Unexpected);
    await expect(driver.sendMessage(ref(2), "Hello", { messageCount: 0 })).rejects.toBeInstanceOf(Unexpected);
    expect(world.log.filter((entry) => entry.kind === "message")).toEqual([]);
    expect(world.thread("test-person-1")).toEqual([]);
  });
});

describe("scripted members", () => {
  it("reply a set number of hours after the app's first message, not before", async () => {
    const env = setup([person(1, { degree: 1, repliesAfterHours: 30 })]);
    await env.driver.sendMessage(ref(1), "Hello", { messageCount: 0 });
    const firstAt = env.clock.now().getTime();
    env.clock.advance(30 * HOUR - 2 * STEP);
    expect((await env.driver.readThread(ref(1))).messages.map((message) => message.sender)).toEqual(["user"]);
    expect((await env.driver.readThread(ref(1))).messages.map((message) => message.sender)).toEqual(["user", "participant"]);
    expect(env.world.thread("test-person-1").at(-1)).toMatchObject({
      sender: "participant",
      source: "member",
      at: new Date(firstAt + 30 * HOUR),
    });
  });

  it("write first after accepting, before the app has messaged", async () => {
    const env = setup([person(1, { acceptsAfterHours: 3, repliesBeforeFirstMessageAfterHours: 10, replyText: "Thanks for connecting" })]);
    const connectedAt = await inviteAndAccept(env, 1, null);
    env.clock.advance(DAY);
    await env.driver.readThread(ref(1));
    expect(env.world.thread("test-person-1")).toEqual([
      { sender: "participant", source: "member", text: "Thanks for connecting", at: new Date(connectedAt.getTime() + 10 * HOUR) },
    ]);
  });

  it("do not write first when the app has already messaged them", async () => {
    const env = setup([person(1, { degree: 1, repliesBeforeFirstMessageAfterHours: 10 })]);
    await env.driver.sendMessage(ref(1), "Hello", { messageCount: 0 });
    env.clock.advance(DAY);
    await env.driver.readThread(ref(1));
    expect(env.world.thread("test-person-1").map((message) => message.source)).toEqual(["app"]);
  });

  it("the user messages them by hand a set number of hours after they connected", async () => {
    const env = setup([person(1, { acceptsAfterHours: 1, userWritesAfterHours: 20, userText: "Ciao, I'll take it from here" })]);
    const connectedAt = await inviteAndAccept(env, 1, null);
    env.clock.advance(DAY);
    const thread = await env.driver.readThread(ref(1));
    expect(thread.messages).toMatchObject([{ sender: "user", senderName: "Test User", text: "Ciao, I'll take it from here" }]);
    expect(env.world.thread("test-person-1")).toMatchObject([{ source: "manual", at: new Date(connectedAt.getTime() + 20 * HOUR) }]);
    expect(env.world.messagesSentTo("test-person-1")).toEqual([]);
  });

  it("the user re-sends by hand a text identical to the app's last message", async () => {
    const env = setup([person(1, { degree: 1, userResendsAfterHours: 4 })]);
    await env.driver.sendMessage(ref(1), "Quick question ?", { messageCount: 0 });
    env.clock.advance(5 * HOUR);
    const thread = await env.driver.readThread({ memberId: "ACoATestPerson1" });
    expect(thread.messages.map((message) => [message.sender, message.text])).toEqual([
      ["user", "Quick question ?"],
      ["user", "Quick question ?"],
    ]);
    expect(env.world.thread("test-person-1").map((message) => message.source)).toEqual(["app", "manual"]);
    expect(env.world.messagesSentTo("test-person-1")).toHaveLength(1);
  });

  it("a reply that falls between the pre-send read and the send is seen by the send: nothing goes out", async () => {
    const env = setup([person(1, { degree: 1, repliesBeforeFirstMessageAfterHours: 1 })]);
    env.clock.advance(HOUR - STEP - 1_000);
    const before = await env.driver.readThread(ref(1));
    expect(before.isNew).toBe(true);
    expect(await env.driver.sendMessage(ref(1), "Hello", { messageCount: before.messages.length })).toBe("thread_changed");
    expect(env.world.thread("test-person-1").map((message) => message.source)).toEqual(["member"]);
    expect(env.world.messagesSentTo("test-person-1")).toEqual([]);
  });
});

describe("listRecentConnections", () => {
  it("shows the 40 newest connections, newest first; the 41st falls off", async () => {
    const members = Array.from({ length: 41 }, (_, k) => person(k + 1, { degree: 1, connectedAt: new Date(START.getTime() - (k + 1) * DAY) }));
    const { driver } = setup(members);
    const cards = await driver.listRecentConnections();
    expect(cards).toHaveLength(40);
    expect(cards.at(0)?.publicId).toBe("test-person-1");
    expect(cards.at(-1)?.publicId).toBe("test-person-40");
    expect(cards.map((card) => card.publicId)).not.toContain("test-person-41");
    expect(cards.every((card) => card.memberId !== null && card.connectedOn !== null)).toBe(true);
  });
});

describe("listSentInvitations", () => {
  it("lists pending invitations, newest first, at most 50, including ones sent outside the app", async () => {
    const members = Array.from({ length: 51 }, (_, k) =>
      person(k + 1, { invitedOutsideApp: true, invitedAt: new Date(START.getTime() - (k + 1) * DAY) }),
    );
    const { world, driver } = setup([...members, person(99)]);
    await driver.sendInvite(ref(99), null);
    const cards = await driver.listSentInvitations();
    expect(cards).toHaveLength(50);
    expect(cards.slice(0, 3).map((card) => [card.publicId, card.sentText])).toEqual([
      ["test-person-99", "Sent today"],
      ["test-person-1", "Sent 1 day ago"],
      ["test-person-2", "Sent 2 days ago"],
    ]);
    expect(cards.at(-1)?.publicId).toBe("test-person-49");
    expect(cards.every((card) => card.canWithdraw)).toBe(true);
    expect(world.status("test-person-51").pendingSince).not.toBeNull();
  });
});

describe("discovery", () => {
  it("search returns the registered people page by page", async () => {
    const members = Array.from({ length: 12 }, (_, k) => person(k + 1, k === 0 ? { degree: 1 } : {}));
    const { world, driver } = setup(members);
    world.setSearchResults(
      "tester",
      members.map((member) => member.publicId),
    );
    const first = await driver.searchPeople({ keywords: "tester" });
    expect(first.cards).toHaveLength(10);
    expect(first.hasNextPage).toBe(true);
    expect(first.cards.at(0)).toMatchObject({ publicId: "test-person-1", degree: 1, action: "message" });
    expect(first.cards.at(1)).toMatchObject({ publicId: "test-person-2", degree: 2, action: "connect" });
    const second = await driver.searchPeople({ keywords: "tester", page: 2 });
    expect(second.cards.map((card) => card.publicId)).toEqual(["test-person-11", "test-person-12"]);
    expect(second.hasNextPage).toBe(false);
    expect((await driver.searchPeople({ keywords: "nothing" })).cards).toEqual([]);
  });

  it("recommendations return the registered groups, without connections", async () => {
    const { world, driver } = setup([person(1), person(2, { degree: 1 }), person(3, { invitedOutsideApp: true })]);
    world.setRecommendations([{ title: "People you may know", publicIds: ["test-person-1", "test-person-2", "test-person-3"] }]);
    const result = await driver.listRecommendations();
    expect(result.groups).toMatchObject([
      {
        kind: "people",
        title: "People you may know",
        cards: [
          { publicId: "test-person-1", action: "connect", group: "People you may know" },
          { publicId: "test-person-3", action: "pending" },
        ],
      },
    ]);
  });
});

describe("the log", () => {
  it("timestamps every entry with the clock at the moment of the effect", async () => {
    const { clock, world, driver } = setup([person(1, { degree: 1 })]);
    await driver.ensureSession();
    clock.advance(HOUR);
    await driver.sendMessage(ref(1), "Hello", { messageCount: 0 });
    expect(world.log.map((entry) => [entry.kind, entry.page ?? null, entry.at.getTime() - START.getTime()])).toEqual([
      ["page_load", "feed", STEP],
      ["page_load", "messaging", STEP + HOUR + STEP],
      ["message", null, STEP + HOUR + STEP],
    ]);
  });

  it("cannot be changed through what it returns", async () => {
    const { world, driver } = setup();
    await driver.ensureSession();
    const log = world.log as unknown[];
    log.pop();
    expect(world.log).toHaveLength(1);
    expect(Object.isFrozen(world.log.at(0))).toBe(true);
  });
});
