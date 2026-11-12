/**
 * `npx tsx scripts/fixtures/lists.ts`
 *
 * Turns the captures of three list pages (real people's data, git-ignored) into committed fixtures:
 *
 * - `captures/search-people.html` → `fixtures/search/people-en.html`
 * - `captures/connections.html` → `fixtures/connections/recent-en.html`
 * - `captures/invitations-sent.html` → `fixtures/invitations/sent-en.html`
 * - `captures/later-search-people.html` → `fixtures/search/people-later-en.html`
 * - `captures/later-connections.html` → `fixtures/connections/recent-later-en.html`
 * - `captures/later-search-language-suffix.html` → `fixtures/search/people-language-suffix-en.html`
 *   (the page that raised a safety stop on 2026-11-12: one result's profile link is `/in/<id>/en/`)
 *
 * The `later-` captures are later page loads, which carry no `data-view-name` (see `selectors.lists.ts`).
 *
 * The parsers find the sensitive strings (names, headlines, locations, summary lines). Two kinds of
 * identifier `scrubHtml` leaves in place are replaced first: profile slugs inside `componentkey`
 * values ("ConnectionCard_0-<public id>") and member URN ids ("ACoAA…") in `id`, `componentkey` and
 * message links. Then `scrubHtml` replaces the rest, and the script re-parses the fixture and fails
 * if the item count changed or any collected string is still in it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";
import type { Card } from "../../src/linkedin/parse/card";
import { parseConnections } from "../../src/linkedin/parse/connections";
import { parseSearchResults } from "../../src/linkedin/parse/search";
import { parseSentInvitations } from "../../src/linkedin/parse/sentInvitations";
import { scrubHtml, type Sensitive } from "../../src/linkedin/scrub";

interface ListPage {
  readonly capture: string;
  readonly fixture: string;
  readonly parse: (html: string) => readonly Card[];
  /** Personal text a card carries beyond name and headline. */
  readonly extraTexts: (card: Card) => readonly (string | null)[];
  /** Names of other people the page shows besides the cards (mutual connections). */
  readonly otherNames?: (html: string) => readonly string[];
}

const repoPath = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

const pages: readonly ListPage[] = [
  {
    capture: "captures/search-people.html",
    fixture: "fixtures/search/people-en.html",
    parse: (html) => parseSearchResults(html).cards,
    extraTexts: (card) => [card.location, "summary" in card && typeof card.summary === "string" ? card.summary : null],
  },
  {
    capture: "captures/later-search-people.html",
    fixture: "fixtures/search/people-later-en.html",
    parse: (html) => parseSearchResults(html).cards,
    extraTexts: (card) => [card.location, "summary" in card && typeof card.summary === "string" ? card.summary : null],
    otherNames: mutualConnectionNames,
  },
  {
    capture: "captures/later-search-language-suffix.html",
    fixture: "fixtures/search/people-language-suffix-en.html",
    parse: (html) => parseSearchResults(html).cards,
    extraTexts: (card) => [card.location, "summary" in card && typeof card.summary === "string" ? card.summary : null],
    otherNames: mutualConnectionNames,
  },
  {
    capture: "captures/connections.html",
    fixture: "fixtures/connections/recent-en.html",
    parse: parseConnections,
    extraTexts: (card) => [card.location],
  },
  {
    capture: "captures/later-connections.html",
    fixture: "fixtures/connections/recent-later-en.html",
    parse: parseConnections,
    extraTexts: (card) => [card.location],
  },
  {
    capture: "captures/invitations-sent.html",
    fixture: "fixtures/invitations/sent-en.html",
    parse: parseSentInvitations,
    extraTexts: (card) => [card.location],
  },
];

const MEMBER_URN = /ACoAA[A-Za-z0-9_-]+/g;

/** "<name> is a mutual connection" lines under a search result: every profile link in a row's paragraphs after its first (the row's own name). */
function mutualConnectionNames(html: string): string[] {
  return parse(html)
    .querySelectorAll('[role="listitem"]')
    .flatMap((row) => row.querySelectorAll('p a[href*="/in/"]').slice(1))
    .map((link) => link.text.replace(/\s+/g, " ").trim())
    .filter((name) => name !== "");
}

function sensitiveFrom(cards: readonly Card[], extraTexts: ListPage["extraTexts"], otherNames: readonly string[] = []): Required<Sensitive> {
  const names = new Set<string>(otherNames);
  const texts = new Set<string>();
  const companies = new Set<string>();
  for (const card of cards) {
    names.add(card.fullName);
    if (card.company !== null) companies.add(card.company);
    for (const text of [card.headline, ...extraTexts(card)]) {
      if (text !== null && text.length >= 3 && /\p{L}/u.test(text)) texts.add(text);
    }
  }
  return { names: [...names], companies: [...companies], texts: [...texts] };
}

/** Replaces identifiers `scrubHtml` does not: public ids outside `/in/` links, and member URNs. */
function replaceIdentifiers(html: string, cards: readonly Card[]): { html: string; urns: readonly string[] } {
  let out = html;
  // Longest first, so an id that ends another id cannot replace part of it. A leading "-" is allowed:
  // componentkey values join a row index and the id with one ("ConnectionCard_0-<id>").
  const ids = cards.map((card, index) => ({ id: card.publicId, standIn: `person-${index + 1}` }));
  for (const { id, standIn } of ids.sort((a, b) => b.id.length - a.id.length)) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(id)}(?![A-Za-z0-9-])`, "gi"), standIn);
  }
  const urns = [...new Set(html.match(MEMBER_URN) ?? [])];
  const numbering = new Map(urns.map((urn, index) => [urn, `ACoAAmember${index + 1}`]));
  out = out.replace(MEMBER_URN, (urn) => numbering.get(urn) ?? urn);
  return { html: out, urns };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The user's own search keywords: words in them are his query, not a person's data. */
function searchKeywords(html: string): Set<string> {
  const value = parse(html).querySelector('[data-testid="typeahead-input"]')?.getAttribute("value") ?? "";
  return new Set(value.toLowerCase().split(/\s+/).filter((word) => word !== ""));
}

/** Collected strings still present in the fixture, as "<kind> #<n>" labels (never the strings themselves). */
function leaks(
  fixture: string,
  cards: readonly Card[],
  sensitive: Required<Sensitive>,
  urns: readonly string[],
  keywords: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  /** `flags` set means a whole-word match with those flags; unset means an exact substring. */
  const check = (kind: string, values: readonly string[], flags?: string) =>
    values.forEach((value, index) => {
      const pattern = flags === undefined ? null : new RegExp(`(?<![\\p{L}])${escapeRegExp(value)}(?![\\p{L}])`, flags);
      if (pattern === null ? fixture.includes(value) : pattern.test(fixture)) found.push(`${kind} #${index + 1}`);
    });
  check("name", sensitive.names);
  const nameWords = sensitive.names
    .flatMap((name) => name.split(/\s+/))
    .filter((word) => /\p{L}{3,}/u.test(word) && !keywords.has(word.toLowerCase()));
  // Case-sensitive: a capitalised name word ("Screen") is not the attribute name "data-sdui-screen".
  check("name word", [...new Set(nameWords)], "u");
  check("text", sensitive.texts);
  check("company", sensitive.companies);
  check("public id", cards.map((card) => card.publicId), "iu");
  check("member urn", urns);
  return found;
}

function main(): void {
  let failed = false;
  for (const page of pages) {
    const capture = readFileSync(repoPath(page.capture), "utf8");
    const cards = page.parse(capture);
    const sensitive = sensitiveFrom(cards, page.extraTexts, page.otherNames?.(capture));
    const { html, urns } = replaceIdentifiers(capture, cards);
    const fixture = scrubHtml(html, sensitive);

    const fixtureCards = page.parse(fixture);
    const leaked = leaks(fixture, cards, sensitive, urns, searchKeywords(capture));
    const target = repoPath(page.fixture);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, fixture);
    console.log(
      `${page.fixture}: ${cards.length} cards in capture, ${fixtureCards.length} in fixture; scrubbed ${sensitive.names.length} names, ` +
        `${sensitive.texts.length} texts, ${urns.length} member ids; leaks: ${leaked.length === 0 ? "none" : leaked.join(", ")}`,
    );
    if (fixtureCards.length !== cards.length || leaked.length > 0) failed = true;
  }
  if (failed) {
    console.error("fixture check failed: fix the scrub before committing");
    process.exitCode = 1;
  }
}

main();
