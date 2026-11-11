import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLiveDriver, type DriverPage, type ReadDriver } from "./driver";
import { Checkpoint, LoggedOut, Restricted, Unexpected } from "./errors";

const fixture = (path: string) => readFileSync(join(process.cwd(), "fixtures", path), "utf8");

/** What the fake window shows for a URL: the page it lands on (after any redirect) and its HTML. */
type Route = (url: string) => { readonly url: string; readonly html: string };

/**
 * A stand-in for the dedicated window that serves fixtures. It records every page load and every
 * pacing wait in order, so tests can see what the driver did on LinkedIn.
 */
function fakeWindow(route: Route) {
  const events: string[] = [];
  let current = { url: "about:blank", html: "<html></html>" };
  const page: DriverPage = {
    load: async (url) => {
      events.push(`load ${url}`);
      current = route(url);
    },
    url: () => current.url,
    content: async () => current.html,
    screenshot: async () => Buffer.from(""),
  };
  const driver = createLiveDriver({
    page,
    pace: async () => {
      events.push("pace");
    },
    health: { screenshotsDir: mkdtempSync(join(tmpdir(), "driver-")) },
  });
  return { driver, events, loads: () => events.filter((e) => e.startsWith("load ")) };
}

/** Serves the fixture whose page the URL names, as a signed-in user would see it. */
const linkedIn: Route = (url) => {
  const { pathname } = new URL(url);
  const pages: readonly (readonly [string, string])[] = [
    ["/feed/", "session/synthetic-feed-signed-in.html"],
    ["/search/results/people/", "search/people-en.html"],
    ["/mynetwork/grow/", "recommendations/grow-en.html"],
    ["/mynetwork/invite-connect/connections/", "connections/recent-en.html"],
    ["/mynetwork/invitation-manager/sent/", "invitations/sent-en.html"],
    ["/messaging/compose/", "messaging/two-way-en.html"],
    ["/messaging/", "messaging/inbox-inmail-en.html"],
    ["/in/", "profile/not-connected-a-en.html"],
  ];
  const match = pages.find(([prefix]) => pathname.startsWith(prefix));
  if (match === undefined) throw new Error(`no fixture for ${url}`);
  return { url, html: fixture(match[1]) };
};

describe("the live driver on saved pages", () => {
  it("reports an ok session from the feed", async () => {
    const { driver, loads } = fakeWindow(linkedIn);

    expect((await driver.ensureSession()).state).toBe("ok");
    expect(loads()).toEqual(["load https://www.linkedin.com/feed/"]);
  });

  it("searches people by keywords and returns the result page's cards", async () => {
    const { driver, loads } = fakeWindow(linkedIn);

    const result = await driver.searchPeople({ keywords: "head of sales", page: 2 });

    expect(loads()).toEqual(["load https://www.linkedin.com/search/results/people/?keywords=head+of+sales&page=2"]);
    expect(result.cards).toHaveLength(10);
    expect(result.cards[0]?.publicId).toBe("person-1");
    expect(result.hasNextPage).toBe(true);
    expect(result.capped).toBe(false);
  });

  it("searches a people-search URL the user pasted", async () => {
    const { driver, loads } = fakeWindow(linkedIn);
    const url = "https://www.linkedin.com/search/results/people/?keywords=cfo&network=%5B%22S%22%5D";

    await driver.searchPeople({ url, page: 3 });

    expect(loads()).toEqual([`load ${url}&page=3`]);
  });

  it("refuses a search URL that is not a LinkedIn people search, without loading anything", async () => {
    const { driver, events } = fakeWindow(linkedIn);

    await expect(driver.searchPeople({ url: "https://example.com/search/results/people/" })).rejects.toThrow(RangeError);
    expect(events).toEqual([]);
  });

  it("lists the recommendation groups of My Network → Grow", async () => {
    const { driver, loads } = fakeWindow(linkedIn);

    const { groups } = await driver.listRecommendations();

    expect(loads()).toEqual(["load https://www.linkedin.com/mynetwork/grow/"]);
    expect(groups.filter((g) => g.kind === "people").flatMap((g) => g.cards)).toHaveLength(80);
  });

  it("opens a profile and adds the member id its Message control carries", async () => {
    const { driver, loads } = fakeWindow(linkedIn);

    const profile = await driver.viewProfile("person-1");

    expect(loads()).toEqual(["load https://www.linkedin.com/in/person-1/"]);
    expect(profile.publicId).toBe("person-1");
    expect(profile.memberId).toBe("ACoA00000000000000000000000000000000001");
  });

  it("lists recent connections, newest first, each with the member id of its Message control", async () => {
    const { driver, loads } = fakeWindow(linkedIn);

    const connections = await driver.listRecentConnections();

    expect(loads()).toEqual(["load https://www.linkedin.com/mynetwork/invite-connect/connections/"]);
    expect(connections).toHaveLength(58);
    expect(connections.every((c) => c.degree === 1)).toBe(true);
    expect(new Set(connections.map((c) => c.memberId)).size).toBe(58);
    expect(connections.every((c) => c.memberId?.startsWith("ACoAAmember") === true)).toBe(true);
  });

  it("lists sent invitations", async () => {
    const { driver, loads } = fakeWindow(linkedIn);

    const invitations = await driver.listSentInvitations();

    expect(loads()).toEqual(["load https://www.linkedin.com/mynetwork/invitation-manager/sent/"]);
    expect(invitations.length).toBeGreaterThan(0);
  });

  it("lists conversations and reads the one the messaging page opens", async () => {
    const { driver, loads } = fakeWindow(linkedIn);

    const { conversations, open } = await driver.listConversations();

    expect(loads()).toEqual(["load https://www.linkedin.com/messaging/"]);
    expect(conversations).toHaveLength(10);
    expect(open?.participant.publicId).toBe("person-1");
    expect(open?.messages).toHaveLength(1);
  });

  it("reads the conversation with a person by opening it from their member id", async () => {
    const { driver, loads } = fakeWindow(linkedIn);

    const thread = await driver.readThread({ memberId: "person-1" });

    expect(loads()).toEqual([
      "load https://www.linkedin.com/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3Aperson-1&recipient=person-1",
    ]);
    expect(thread.participant.publicId).toBe("person-1");
    expect(thread.messages.map((m) => m.sender)).toContain("user");
    expect(thread.messages.map((m) => m.sender)).toContain("participant");
    expect(thread.threadUrl).toBeNull();
  });

  it("returns the thread URL when LinkedIn lands on one", async () => {
    const { driver } = fakeWindow(() => ({
      url: "https://www.linkedin.com/messaging/thread/2-abc/",
      html: fixture("messaging/two-way-en.html"),
    }));

    expect((await driver.readThread({ memberId: "person-1" })).threadUrl).toBe("https://www.linkedin.com/messaging/thread/2-abc/");
  });

  it("reads a new conversation, which names the person by public id, as no messages", async () => {
    const { driver } = fakeWindow((url) => ({ url, html: fixture("messaging/synthetic-new-message-en.html") }));

    const thread = await driver.readThread({ memberId: "ACoAAgina", publicId: "gina-prova" });

    expect(thread.isNew).toBe(true);
    expect(thread.messages).toEqual([]);
    await expect(driver.readThread({ memberId: "ACoAAgina" })).rejects.toThrow(Unexpected);
    await expect(driver.readThread({ memberId: "ACoAAgina", publicId: "someone-else" })).rejects.toThrow(Unexpected);
  });

  it("reads earlier messages listed in the new-message pane of a connection", async () => {
    const { driver } = fakeWindow((url) => ({ url, html: fixture("messaging/compose-existing-en.html") }));

    const thread = await driver.readThread({ memberId: "person-1" });

    expect(thread.isNew).toBe(false);
    expect(thread.messages).toHaveLength(6);
    await expect(driver.readThread({ memberId: "ACoAAsomeoneElse" })).rejects.toThrow(Unexpected);
  });

  it("refuses to return a conversation with someone other than the person asked for", async () => {
    const { driver } = fakeWindow(linkedIn);

    await expect(driver.readThread({ memberId: "ACoAAsomeoneElse" })).rejects.toThrow(Unexpected);
  });

  it("turns a page the parser cannot read into an Unexpected error", async () => {
    const { driver } = fakeWindow((url) => ({ url, html: fixture("session/synthetic-feed-signed-in.html") }));

    await expect(driver.viewProfile("person-1")).rejects.toThrow(Unexpected);
  });

  it("paces before every page load", async () => {
    const { driver, events } = fakeWindow(linkedIn);

    await driver.ensureSession();
    await driver.listRecentConnections();
    await driver.readThread({ memberId: "person-1" });

    expect(events.map((e) => e.split(" ")[0])).toEqual(["pace", "load", "pace", "load", "pace", "load"]);
  });
});

const operations: readonly (readonly [string, (driver: ReadDriver) => Promise<unknown>])[] = [
  ["ensureSession", (d) => d.ensureSession()],
  ["searchPeople", (d) => d.searchPeople({ keywords: "cfo" })],
  ["listRecommendations", (d) => d.listRecommendations()],
  ["viewProfile", (d) => d.viewProfile("person-1")],
  ["listRecentConnections", (d) => d.listRecentConnections()],
  ["listSentInvitations", (d) => d.listSentInvitations()],
  ["listConversations", (d) => d.listConversations()],
  ["readThread", (d) => d.readThread({ memberId: "person-1" })],
];

const stops = [
  ["a login wall", () => ({ url: "https://www.linkedin.com/authwall?trk=x", html: "<html></html>" }), LoggedOut],
  [
    "a checkpoint",
    () => ({ url: "https://www.linkedin.com/checkpoint/challenge/x", html: fixture("session/synthetic-checkpoint-challenge-en.html") }),
    Checkpoint,
  ],
  ["a restriction notice", (url: string) => ({ url, html: fixture("session/synthetic-restricted-en.html") }), Restricted],
] as const;

describe.each(stops)("on %s", (_name, route, ErrorClass) => {
  it.each(operations)("%s throws the matching error after one page load", async (_op, run) => {
    const { driver, loads } = fakeWindow(route);

    await expect(run(driver)).rejects.toThrow(ErrorClass);
    expect(loads()).toHaveLength(1);
  });

  it.each(operations)("%s afterwards throws the same error without loading a page", async (_op, run) => {
    const { driver, events } = fakeWindow(route);
    const first = await driver.ensureSession().catch((error: unknown) => error);
    const before = events.length;

    await expect(run(driver)).rejects.toBe(first);
    expect(events).toHaveLength(before);
  });
});
