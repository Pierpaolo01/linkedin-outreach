import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ParseError } from "./card";
import { parseSearchResults } from "./search";

const SCREEN = "com.linkedin.sdui.flagshipnav.search.SearchResultsPeople";

interface RowSpec {
  readonly id?: string;
  readonly name?: string;
  readonly degree?: string;
  readonly headline?: string;
  readonly location?: string;
  readonly summary?: string;
  /** Inner HTML of the action wrapper; empty string for no wrapper. */
  readonly action?: string;
}

const message = (name: string) =>
  `<div data-view-name="message-button"><a href="/messaging/compose/?profileUrn=x" aria-label="Send a message to ${name}"><span>Message</span></a></div>`;

function row({
  id = "person-1",
  name = "Person 1",
  degree = "• 3rd+",
  headline = "Owner at Company 1",
  location = "Milan, Lombardy, Italy",
  summary,
  action = message(name),
}: RowSpec = {}): string {
  const href = `https://www.linkedin.com/in/${id}/?miniProfileUrn=abc`;
  return `<div role="listitem"><div data-view-name="people-search-result">
    <a href="${href}"><div><div>
      <figure data-view-name="image"><img alt="${name}"></figure>
      <div>
        <p><a href="${href}" data-view-name="search-result-lockup-title">${name}</a><span class="i87ll3"><span>${degree}</span></span></p>
        <div><p><span>${headline}</span></p></div>
        <div><p><span>${location}</span></p></div>
      </div>
      <div>${action === "" ? "" : `<div data-view-name="relationship-building-button">${action}</div>`}</div>
    </div>
    ${summary === undefined ? "" : `<div id="SearchResultssnippet_x"><div><p>${summary}</p></div></div>`}
    </div></a>
  </div><hr role="presentation"></div>`;
}

function page(rows: string, { lang = "en", extra = "", next = true } = {}): string {
  const pagination = `<ul data-testid="pagination-controls-list"></ul><button data-testid="pagination-controls-next-button-${next ? "visible" : "hidden"}">Next</button>`;
  return `<!doctype html><html lang="${lang}"><body><header data-testid="primary-nav"></header><main id="workspace"><div data-sdui-screen="${SCREEN}"><section aria-label="Primary content"><div role="list">${rows}</div>${extra}${pagination}</section></div></main></body></html>`;
}

describe("parseSearchResults on hand-written pages", () => {
  it("reads a result row into a card with a canonical profile URL", () => {
    const result = parseSearchResults(page(row()));

    expect(result).toEqual({
      cards: [
        {
          publicId: "person-1",
          profileUrl: "https://www.linkedin.com/in/person-1/",
          fullName: "Person 1",
          headline: "Owner at Company 1",
          location: "Milan, Lombardy, Italy",
          company: null,
          degree: 3,
          action: "message",
          summary: null,
        },
      ],
      hasNextPage: true,
      capped: false,
      hiddenMembers: 0,
    });
  });

  it.each([
    ["message", message("Person 1")],
    [
      "connect",
      '<div data-view-name="edge-creation-connect-action"><button aria-label="Invite Person 1 to connect">Connect</button></div>',
    ],
    ["follow", '<div data-view-name="edge-creation-follow-action"><button aria-label="Follow Person 1">Follow</button></div>'],
    [
      "pending",
      '<div data-view-name="some-new-name"><button aria-label="Pending, click to withdraw invitation sent to Person 1">Pending</button></div>',
    ],
  ] as const)("reads the %s action", (expected, action) => {
    expect(parseSearchResults(page(row({ action }))).cards[0]?.action).toBe(expected);
  });

  it("reads a row with no action as action null", () => {
    expect(parseSearchResults(page(row({ action: "" }))).cards[0]?.action).toBeNull();
  });

  it("throws ParseError naming the row when the action is not recognised", () => {
    const action = '<div data-view-name="mystery-button"><button aria-label="Do something">Do</button></div>';

    expect(() => parseSearchResults(page(row() + row({ id: "person-2", action })))).toThrow(
      /result 2: unrecognised action \(data-view-name: mystery-button\)/,
    );
  });

  it.each([
    ["• 1st", 1],
    ["• 2nd", 2],
    ["• 3rd+", 3],
    ["", null],
  ] as const)("reads degree %j as %s", (degree, expected) => {
    expect(parseSearchResults(page(row({ degree }))).cards[0]?.degree).toBe(expected);
  });

  it("keeps the summary line and reads the company only from a 'Current: … at …' label", () => {
    const generated = parseSearchResults(page(row({ summary: "Owner at Company 1 since 2010, running a business." })));
    const labelled = parseSearchResults(page(row({ summary: "Current: Owner at Company 1 S.r.l." })));

    expect(generated.cards[0]).toMatchObject({ summary: "Owner at Company 1 since 2010, running a business.", company: null });
    expect(labelled.cards[0]?.company).toBe("Company 1 S.r.l.");
  });

  it("reports the last page", () => {
    expect(parseSearchResults(page(row(), { next: false })).hasNextPage).toBe(false);
  });

  it("returns an empty list on a page that says there are no results", () => {
    const result = parseSearchResults(page("", { extra: "<h2>No results found</h2>", next: false }));

    expect(result).toEqual({ cards: [], hasNextPage: false, capped: false, hiddenMembers: 0 });
  });

  it("flags the monthly commercial-use limit notice (wording unverified)", () => {
    const notice = "<p>You’ve reached the monthly limit for profile searches.</p>";

    expect(parseSearchResults(page("", { extra: notice, next: false })).capped).toBe(true);
  });

  it("ignores notice wording inside scripts and styles", () => {
    const bundled = '<script>window.i18n = { cap: "commercial use limit", none: "No results found" };</script><style>/* commercial use limit */</style>';

    expect(parseSearchResults(page(row(), { extra: bundled })).capped).toBe(false);
    expect(() => parseSearchResults(page("", { extra: bundled }))).toThrow(ParseError);
  });

  it("throws ParseError on a search page with no rows and no notice", () => {
    expect(() => parseSearchResults(page(""))).toThrow(ParseError);
  });

  it("throws ParseError on a page that is not a people search", () => {
    const feed = '<html lang="en"><body><main data-sdui-screen="com.linkedin.sdui.flagshipnav.feed.Feed"></main></body></html>';

    expect(() => parseSearchResults(feed)).toThrow(/search: not the search page/);
  });

  it("throws ParseError naming the row when a name is missing", () => {
    expect(() => parseSearchResults(page(row() + row({ id: "person-2", name: "" })))).toThrow(/result 2: no name/);
  });

  it("throws ParseError naming the row when the profile link is missing", () => {
    const broken = row({ id: "person-2" }).replaceAll("https://www.linkedin.com/in/person-2/?miniProfileUrn=abc", "#");

    expect(() => parseSearchResults(page(row() + broken))).toThrow(/result 2: no profile link/);
  });

  it("counts hidden out-of-network members instead of returning them", () => {
    const hidden = row({ name: "LinkedIn Member" }).replaceAll(/ href="[^"]*"/g, "");

    const result = parseSearchResults(page(row() + hidden));

    expect(result.cards).toHaveLength(1);
    expect(result.hiddenMembers).toBe(1);
  });

  it("never returns the user himself", () => {
    const result = parseSearchResults(page(row() + row({ id: "me-myself" })), { selfPublicId: "me-myself" });

    expect(result.cards.map((card) => card.publicId)).toEqual(["person-1"]);
  });

  it("reads an Italian page (wording unverified)", () => {
    const action =
      '<div data-view-name="new-name"><button aria-label="Invita Persona 1 a collegarsi">Collegati</button></div>';
    const result = parseSearchResults(page(row({ name: "Persona 1", degree: "• 2°", action }), { lang: "it-IT" }));

    expect(result.cards[0]).toMatchObject({ fullName: "Persona 1", degree: 2, action: "connect" });
  });

  it("returns an empty list on an Italian page with no results (wording unverified)", () => {
    const result = parseSearchResults(page("", { lang: "it", extra: "<h2>Nessun risultato trovato</h2>" }));

    expect(result.cards).toEqual([]);
  });
});

describe("parseSearchResults on the committed fixture", () => {
  const html = readFileSync(new URL("../../../fixtures/search/people-en.html", import.meta.url), "utf8");
  const result = parseSearchResults(html);

  it("reads every result the capture had", () => {
    expect(result.cards).toHaveLength(10);
    expect(result).toMatchObject({ hasNextPage: true, capped: false, hiddenMembers: 0 });
  });

  it("gives each card its required fields, a 3rd+ degree and the Message action", () => {
    for (const card of result.cards) {
      expect(card.publicId).toMatch(/^person-\d+$/);
      expect(card.profileUrl).toBe(`https://www.linkedin.com/in/${card.publicId}/`);
      expect(card.fullName).toMatch(/^Person \d+$/);
      expect(card.headline).not.toBeNull();
      expect(card.location).not.toBeNull();
      expect(card.summary).not.toBeNull();
      expect(card).toMatchObject({ degree: 3, action: "message", company: null });
    }
    expect(new Set(result.cards.map((card) => card.publicId)).size).toBe(10);
  });
});
