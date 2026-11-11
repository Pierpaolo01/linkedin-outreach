import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ParseError } from "./card";
import { flattenRecommendations, parseRecommendations } from "./recommendations";

// Hand-written pages that copy the structure of My Network → Grow as saved on 2026-11-11
// (hashed class names left out: the parser must not need them).

interface CardSpec {
  readonly id: string;
  readonly name: string;
  readonly headline?: string;
  readonly insight?: string;
  readonly action?: string;
}

function card({ id, name, headline, insight, action = "Connect" }: CardSpec): string {
  return `
    <div><div role="listitem" componentkey="auto-component-${id}">
      <div><div>
        <a href="https://www.linkedin.com/in/${id}/?miniProfileUrn=x">
          <div aria-label="${name}’s profile picture"><figure aria-hidden="true"><svg></svg></figure></div>
          <div>
            <div><p><span>${name}<span></span><span role="img" aria-label="Verified"><svg></svg></span></span></p></div>
            ${headline === undefined ? "" : `<div><p><span>${headline}</span></p></div>`}
          </div>
        </a>
        <div>
          ${insight === undefined ? "" : `<div><div><figure aria-hidden="true"><svg></svg></figure><div><p><span>${insight}</span></p></div></div></div>`}
          <div><button type="button" aria-label="Invite ${name} to connect"><span><svg></svg><div><span><span>${action}</span></span></div></span></button></div>
        </div>
      </div>
      <div><button type="button" aria-label="Remove ${name} as a suggestion"><span><svg></svg></span></button></div>
    </div></div></div>`;
}

function group(heading: string, cards: readonly string[], showAll: boolean, level: "h2" | "h3" = "h3"): string {
  return `
    <div><section componentkey="auto-component-group">
      <div><div><div>
        <${level}>${heading}</${level}>
        ${showAll ? `<a href="https://www.linkedin.com/mynetwork/grow/" aria-label="Show all suggestions for ${heading}"><span><span>Show all</span></span></a>` : ""}
      </div></div>
      <div role="list">${cards.join("")}</div></div>
    </section></div>`;
}

const invitations = `
  <section componentkey="pending-invitations-preview"><div><div><div>
    <div><h2>Invitations (1)</h2>
      <a aria-label="Show all invitations" href="https://www.linkedin.com/mynetwork/invitation-manager/"><span><span>Show all</span></span></a></div>
    <div role="list"><div><div role="listitem" aria-label="">
      <div><a href="https://www.linkedin.com/in/inviter-1/"><div aria-label="Inviter One’s profile picture"></div></a>
      <div><p><a href="https://www.linkedin.com/in/inviter-1/"><strong>Inviter One</strong></a><span></span>wants to connect</p></div>
      <div><button type="button"><span><span>Ignore</span></span></button><button type="button"><span><span>Accept</span></span></button></div></div>
    </div></div></div>
  </div></div></div></section>`;

function growPage(body: string, lang = "en"): string {
  return `<!DOCTYPE html><html lang="${lang}"><head><title>Grow | LinkedIn</title></head><body>
    <nav data-testid="primary-nav"><a href="https://www.linkedin.com/mynetwork">Network</a></nav>
    <main id="workspace">
      <aside aria-label="Sidebar"><nav><a href="https://www.linkedin.com/mynetwork/invite-connect/connections/">Connections</a></nav></aside>
      <section aria-label="Primary content">
        <nav><ul>
          <li><a aria-current="true" href="https://www.linkedin.com/mynetwork/grow/"><span><span>Grow</span></span></a></li>
          <li><a href="https://www.linkedin.com/mynetwork/catch-up/all/"><span><span>Catch up</span></span></a></li>
        </ul></nav>
        <div><div><div data-testid="lazy-column">${body}</div></div></div>
      </section>
    </main></body></html>`;
}

describe("parseRecommendations on hand-written pages", () => {
  it("reads a people group: title, reason, Show all and its cards", () => {
    const html = growPage(
      group(
        "People you may know from Acme Robotics",
        [
          card({ id: "ada-l", name: "Ada L.", headline: "Engineer at Acme", insight: "Acme Robotics" }),
          card({ id: "bob-k", name: "Bob K.", insight: "Cy and 3 other mutual connections" }),
        ],
        true,
      ),
    );

    const { groups } = parseRecommendations(html);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      title: "People you may know from Acme Robotics",
      kind: "people",
      reason: "Acme Robotics",
      hasShowAll: true,
    });
    expect(groups[0]?.cards).toEqual([
      {
        publicId: "ada-l",
        profileUrl: "https://www.linkedin.com/in/ada-l/",
        fullName: "Ada L.",
        headline: "Engineer at Acme",
        location: null,
        company: null,
        degree: null,
        group: "People you may know from Acme Robotics",
        insight: "Acme Robotics",
        action: "connect",
      },
      {
        publicId: "bob-k",
        profileUrl: "https://www.linkedin.com/in/bob-k/",
        fullName: "Bob K.",
        headline: null,
        location: null,
        company: null,
        degree: null,
        group: "People you may know from Acme Robotics",
        insight: "Cy and 3 other mutual connections",
        action: "connect",
      },
    ]);
  });

  it("reads a group without Show all or a named reason, and a card already invited", () => {
    const html = growPage(
      group("Suggestions for you", [card({ id: "cy", name: "Cy D.", headline: "Founder", action: "Pending" })], false, "h2"),
    );

    const [suggestions] = parseRecommendations(html).groups;

    expect(suggestions).toMatchObject({ title: "Suggestions for you", kind: "people", reason: null, hasShowAll: false });
    expect(suggestions?.cards.map((c) => c.action)).toEqual(["pending"]);
  });

  it("returns no people when the page holds only invitations received and follow suggestions", () => {
    const html = growPage(
      invitations +
        group(
          "Creators to follow",
          [card({ id: "creator", name: "Creator One", headline: "Speaker", action: "Follow" })],
          true,
        ),
    );

    const result = parseRecommendations(html);

    expect(result.groups.map((g) => [g.title, g.kind, g.cards.length])).toEqual([
      ["Invitations (1)", "other", 0],
      ["Creators to follow", "other", 0],
    ]);
    expect(flattenRecommendations(result)).toEqual([]);
  });

  it("throws ParseError on a page that is not My Network → Grow", () => {
    const catchUp = growPage(group("Suggestions for you", [card({ id: "cy", name: "Cy D." })], false)).replace(
      'aria-current="true" href="https://www.linkedin.com/mynetwork/grow/"',
      'href="https://www.linkedin.com/mynetwork/grow/"',
    );

    expect(() => parseRecommendations(catchUp)).toThrow(ParseError);
    expect(() => parseRecommendations("<html lang='en'><body><main></main></body></html>")).toThrow(
      /not the My Network → Grow page/,
    );
  });

  it("throws ParseError on a Grow page with no groups at all", () => {
    expect(() => parseRecommendations(growPage("<section><h2>Grow</h2></section>"))).toThrow(/no groups found/);
  });

  it("throws ParseError naming the card when a card has no name", () => {
    const html = growPage(
      group("Suggestions for you", [card({ id: "cy", name: "Cy D." }), card({ id: "nameless", name: "" })], false),
    );

    expect(() => parseRecommendations(html)).toThrow(ParseError);
    expect(() => parseRecommendations(html)).toThrow(/group 1 card 2 has no name/);
  });

  it("reads the reason from Italian headings", () => {
    const html = growPage(
      group(
        "Persone che potresti conoscere di Acme Robotica",
        [card({ id: "ada-l", name: "Ada L.", insight: "Acme Robotica", action: "Collegati" })],
        true,
      ),
      "it-IT",
    );

    const [first] = parseRecommendations(html).groups;

    expect(first).toMatchObject({ kind: "people", reason: "Acme Robotica" });
    expect(first?.cards[0]?.action).toBe("connect");
  });

  it("never returns the signed-in user", () => {
    const html = growPage(
      group("Suggestions for you", [card({ id: "me-myself", name: "The User" }), card({ id: "cy", name: "Cy D." })], false),
    );

    const cards = flattenRecommendations(parseRecommendations(html, { signedInPublicId: "me-myself" }));

    expect(cards.map((c) => c.publicId)).toEqual(["cy"]);
  });
});

describe("parseRecommendations on the saved Grow page (fixtures/recommendations/grow-en.html)", () => {
  const html = readFileSync(new URL("../../../fixtures/recommendations/grow-en.html", import.meta.url), "utf8");
  const result = parseRecommendations(html);

  it("finds the invitations received, two rows of people and the suggestions grid", () => {
    expect(result.groups.map((g) => [g.kind, g.cards.length, g.hasShowAll, g.reason !== null])).toEqual([
      ["other", 0, true, false],
      ["people", 8, true, true],
      ["people", 8, true, true],
      ["people", 64, false, false],
    ]);
    expect(result.groups[0]?.title).toMatch(/^Invitations \(\d+\)$/);
    expect(result.groups[1]?.title).toMatch(/^People you may know from \S/);
    expect(result.groups[2]?.title).toMatch(/^People you may know in \S/);
    expect(result.groups[3]?.title).toBe("Suggestions for you");
  });

  it("reads every card's required fields and returns canonical profile URLs", () => {
    const cards = result.groups.flatMap((g) => g.cards);
    expect(cards).toHaveLength(80);
    for (const card of cards) {
      expect(card.publicId).not.toBe("");
      expect(card.profileUrl).toBe(`https://www.linkedin.com/in/${card.publicId}/`);
      expect(card.fullName).not.toBe("");
      expect(card.headline).not.toBeNull();
      expect(card.insight).not.toBeNull();
      expect(card.action).toBe("connect");
      expect([card.location, card.company, card.degree]).toEqual([null, null, null]);
    }
  });

  it("flattens to 80 distinct people, each tagged with its group", () => {
    const cards = flattenRecommendations(result);
    expect(new Set(cards.map((c) => c.publicId)).size).toBe(80);
    expect(cards.filter((c) => c.group === "Suggestions for you")).toHaveLength(64);
  });
});

describe("flattenRecommendations", () => {
  it("returns people cards once each, keeping the first group they appeared in", () => {
    const html = growPage(
      group("People you may know from Acme", [card({ id: "ada-l", name: "Ada L." }), card({ id: "bob-k", name: "Bob K." })], true) +
        invitations +
        group("Suggestions for you", [card({ id: "bob-k", name: "Bob K." }), card({ id: "cy", name: "Cy D." })], false, "h2"),
    );

    const cards = flattenRecommendations(parseRecommendations(html));

    expect(cards.map((c) => [c.publicId, c.group])).toEqual([
      ["ada-l", "People you may know from Acme"],
      ["bob-k", "People you may know from Acme"],
      ["cy", "Suggestions for you"],
    ]);
  });
});
