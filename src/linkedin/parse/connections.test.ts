import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ParseError } from "./card";
import { parseConnections } from "./connections";

const SCREEN = "com.linkedin.sdui.flagshipnav.mynetwork.Connections";

interface RowSpec {
  readonly id?: string;
  readonly name?: string;
  readonly headline?: string | null;
  readonly connected?: string | null;
}

function row({ id = "person-1", name = "Person 1", headline = "Engineer at Company 1", connected = "Connected on July 13, 2026" }: RowSpec = {}) {
  const href = `https://www.linkedin.com/in/${id}/`;
  return `<div data-view-name="connections-list"><div componentkey="ConnectionCard_0-${id}">
    <a href="${href}" data-view-name="connections-profile"><figure data-view-name="connections-profile"><img alt="${name}’s profile picture"></figure></a>
    <div><div>
      <a href="${href}" data-view-name="connections-profile"><div><p>${name}</p>${headline === null ? "" : `<div><p><span>${headline}</span></p></div>`}</div></a>
      ${connected === null ? "" : `<p>${connected}</p>`}
    </div></div>
    <div><div>
      <div data-view-name="message-button"><a href="/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AID1&amp;recipient=ACoAAmember-${id}&amp;interop=msgOverlay" aria-label="Send a message to ${name}"><span>Message</span></a></div>
      <button aria-label="More actions for ${name}" data-view-name="connections-remove-connection-dropdown"></button>
    </div></div>
  </div></div>`;
}

function page(rows: string, { lang = "en", extra = "" } = {}) {
  return `<html lang="${lang}"><body><header data-testid="primary-nav"></header><main><div data-sdui-screen="${SCREEN}"><section aria-label="Primary content">${extra}<div data-testid="lazy-column">${rows}</div></section></div></main></body></html>`;
}

describe("parseConnections on hand-written pages", () => {
  it("reads a connection row into a card with its connection date", () => {
    expect(parseConnections(page(row()))).toEqual([
      {
        publicId: "person-1",
        profileUrl: "https://www.linkedin.com/in/person-1/",
        fullName: "Person 1",
        headline: "Engineer at Company 1",
        location: null,
        company: null,
        degree: 1,
        connectedOnText: "Connected on July 13, 2026",
        connectedOn: "2026-07-13",
        memberId: "ACoAAmember-person-1",
      },
    ]);
  });

  it.each([
    ["Connected on Sept 3, 2025", "2025-09-03"],
    ["Connected on February 30, 2026", null],
    ["Connected 2 days ago", null],
    ["Something new", null],
  ] as const)("reads %j as connection date %s and keeps the raw text", (connected, expected) => {
    const [card] = parseConnections(page(row({ connected })));

    expect(card).toMatchObject({ connectedOnText: connected, connectedOn: expected });
  });

  it("reads a row with no headline and no connection line", () => {
    const [card] = parseConnections(page(row({ headline: null, connected: null })));

    expect(card).toMatchObject({ fullName: "Person 1", headline: null, connectedOnText: null, connectedOn: null });
  });

  it("keeps the page order (most recently added first)", () => {
    const cards = parseConnections(page(row({ id: "a" }) + row({ id: "b" }) + row({ id: "c" })));

    expect(cards.map((card) => card.publicId)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list on a page that says there are no connections (wording unverified)", () => {
    expect(parseConnections(page("", { extra: "<h2>You don’t have any connections yet</h2>" }))).toEqual([]);
  });

  it("throws ParseError on a connections page with no rows and no notice", () => {
    expect(() => parseConnections(page(""))).toThrow(/no connection rows/);
  });

  it("throws ParseError on a page that is not the connections list", () => {
    const search = '<html lang="en"><body><div data-sdui-screen="com.linkedin.sdui.flagshipnav.search.SearchResultsPeople"></div></body></html>';

    expect(() => parseConnections(search)).toThrow(ParseError);
    expect(() => parseConnections(search)).toThrow(/connections: not the connections page/);
  });

  it("throws ParseError naming the row when a name is missing", () => {
    expect(() => parseConnections(page(row() + row({ id: "person-2", name: "" })))).toThrow(/connection 2: no name/);
  });

  it("throws ParseError naming the row when the profile link is missing", () => {
    const broken = row({ id: "person-2" }).replaceAll("https://www.linkedin.com/in/person-2/", "/feed/");

    expect(() => parseConnections(page(row() + broken))).toThrow(/connection 2: no profile link/);
  });

  it("never returns the user himself", () => {
    const cards = parseConnections(page(row() + row({ id: "me-myself" })), { selfPublicId: "me-myself" });

    expect(cards.map((card) => card.publicId)).toEqual(["person-1"]);
  });

  it("reads an Italian page with a day-month-year date (wording unverified)", () => {
    const [card] = parseConnections(page(row({ connected: "Collegato il 13 luglio 2026" }), { lang: "it" }));

    expect(card).toMatchObject({ connectedOnText: "Collegato il 13 luglio 2026", connectedOn: "2026-07-13" });
  });

  it("returns an empty list on an Italian page with no connections (wording unverified)", () => {
    expect(parseConnections(page("", { lang: "it", extra: "<p>Non hai ancora nessun collegamento</p>" }))).toEqual([]);
  });
});

describe("parseConnections on the committed fixture", () => {
  const html = readFileSync(new URL("../../../fixtures/connections/recent-en.html", import.meta.url), "utf8");
  const cards = parseConnections(html);

  it("reads every connection the capture had", () => {
    expect(cards).toHaveLength(58);
    expect(new Set(cards.map((card) => card.publicId)).size).toBe(58);
  });

  it("gives each card its required fields, degree 1 and an absolute connection date", () => {
    for (const card of cards) {
      expect(card.profileUrl).toBe(`https://www.linkedin.com/in/${card.publicId}/`);
      expect(card.publicId).toMatch(/^person-\d+$/);
      expect(card.fullName).toMatch(/^Person \d+$/);
      expect(card.headline).not.toBeNull();
      expect(card.degree).toBe(1);
      expect(card.connectedOnText).toMatch(/^Connected on /);
      expect(card.connectedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("keeps LinkedIn's recently-added order", () => {
    const dates = cards.map((card) => card.connectedOn ?? "");

    expect(dates[0]).toBe("2026-07-13");
    expect(dates.at(-1)).toBe("2024-11-01");
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});
