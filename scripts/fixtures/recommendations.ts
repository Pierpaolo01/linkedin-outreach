/**
 * `npx tsx scripts/fixtures/recommendations.ts`
 *
 * Turns the capture of My Network → Grow (`captures/mynetwork-grow.html`, real people's data,
 * git-ignored) into the committed fixture `fixtures/recommendations/grow-en.html`.
 *
 * The parser finds the sensitive strings: names, headlines, the companies, schools and places
 * named in group headings and insight lines, and the first names in mutual-connection lines.
 * The groups the parser leaves without cards (invitations received, non-person suggestions)
 * are swept for link texts and text lines. `scrubHtml` then replaces all of them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HTMLElement, parse, TextNode } from "node-html-parser";
import { publicIdFromUrl } from "../../src/linkedin/parse/card";
import { parseRecommendations } from "../../src/linkedin/parse/recommendations";
import { recommendationsStructural as s, recommendationsWordingFor } from "../../src/linkedin/parse/selectors.recommendations";
import { scrubHtml } from "../../src/linkedin/scrub";
import { languageFromHtml, normaliseText } from "../../src/linkedin/selectors";

const CAPTURE = fileURLToPath(new URL("../../captures/mynetwork-grow.html", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/recommendations/", import.meta.url));
const FIXTURE = `${FIXTURE_DIR}grow-en.html`;

interface Collected {
  readonly names: Set<string>;
  readonly companies: Set<string>;
  readonly texts: Set<string>;
}

/** Returns the public ids of the cards read. */
function collectFromCards(html: string, into: Collected): Set<string> {
  const wording = recommendationsWordingFor(languageFromHtml(html));
  const generic = new Set(wording.genericInsights);
  const read = new Set<string>();
  for (const group of parseRecommendations(html).groups) {
    if (group.reason !== null) keep(into.companies, group.reason);
    for (const card of group.cards) {
      read.add(card.publicId);
      // scrubHtml also replaces the first and last word of each name standing alone ("<first name> is open to work").
      keep(into.names, card.fullName);
      if (card.headline !== null) keep(into.texts, card.headline);
      if (card.insight === null || generic.has(normaliseText(card.insight))) continue;
      const mutual = wording.mutualConnection.map((re) => re.exec(card.insight ?? "")?.[1]).find((n) => n !== undefined);
      if (mutual === undefined) keep(into.companies, card.insight);
      else keep(into.names, mutual);
    }
  }
  return read;
}

/**
 * List items the parser did not turn into cards (invitations received, organisations) still show
 * people and companies: take every link text, and every text outside links and buttons.
 */
function collectFromOtherItems(html: string, read: ReadonlySet<string>, into: Collected): void {
  const main = parse(html).querySelector(s.main);
  for (const item of main?.querySelectorAll(s.card) ?? []) {
    const ids = item.querySelectorAll(s.link).map((a) => publicIdFromUrl(a.getAttribute("href") ?? ""));
    if (ids.some((id) => id !== undefined && read.has(id))) continue;
    for (const a of item.querySelectorAll(s.link)) {
      const text = squash(a.text);
      if (text === "") continue;
      if (publicIdFromUrl(a.getAttribute("href") ?? "") === undefined) keep(into.companies, text);
      else keep(into.names, text);
    }
    for (const text of textsOutsideLinksAndButtons(item)) keep(into.texts, text);
  }
}

function textsOutsideLinksAndButtons(element: HTMLElement): string[] {
  const out: string[] = [];
  for (const child of element.childNodes) {
    if (child instanceof TextNode) {
      const text = squash(child.text);
      if (text !== "") out.push(text);
    } else if (child instanceof HTMLElement && child.rawTagName !== "a" && child.rawTagName !== "button") {
      out.push(...textsOutsideLinksAndButtons(child));
    }
  }
  return out;
}

/** Strings this short or without a letter are not personal, and replacing them everywhere would break the page. */
function keep(set: Set<string>, value: string): void {
  if (value.length >= 3 && /\p{L}/u.test(value)) set.add(value);
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function main(): void {
  const html = readFileSync(CAPTURE, "utf8");
  const collected: Collected = { names: new Set(), companies: new Set(), texts: new Set() };
  const read = collectFromCards(html, collected);
  collectFromOtherItems(html, read, collected);

  const scrubbed = scrubHtml(html, {
    names: [...collected.names],
    companies: [...collected.companies],
    texts: [...collected.texts],
  });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FIXTURE, scrubbed);
  console.log(
    `wrote ${FIXTURE} (${Math.round(scrubbed.length / 1024)} KB; scrubbed ${collected.names.size} names, ` +
      `${collected.companies.size} companies, ${collected.texts.size} texts)`,
  );
}

main();
