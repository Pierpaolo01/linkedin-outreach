/**
 * Turns the two saved profile captures into committed fixtures:
 *   npx tsx scripts/fixtures/profile.ts
 *
 * Reads captures/profile-{a,b}.html (git-ignored, real people's data), collects
 * every personal string on the page (the owner's fields as the parser reads
 * them, plus companies, schools and the other people the page shows), scrubs
 * the page with `scrubHtml` and writes fixtures/profile/not-connected-{a,b}-en.html.
 * Prints counts only, never the strings.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse, HTMLElement, TextNode, type Node } from "node-html-parser";
import { scrubHtml, type Sensitive } from "../../src/linkedin/scrub";
import { parseProfile, type Profile } from "../../src/linkedin/parse/profile";
import { profileStructure } from "../../src/linkedin/parse/selectors.profile";

const PAIRS = [
  { capture: "captures/profile-a.html", fixture: "fixtures/profile/not-connected-a-en.html" },
  { capture: "captures/profile-b.html", fixture: "fixtures/profile/not-connected-b-en.html" },
] as const;

/** aria-labels that name another person or an organisation (English captures). */
const PERSON_LABELS = [/^Invite (.+) to connect$/, /^Message (.+)$/, /^Manage notifications about (.+)$/];
const FOLLOW_LABEL = /^Follow (.+)$/;
const PAGE_LABEL = /^View (.+) page$/;
/** "Sneha & 31 other connections follow this page": the leading name is one of the user's connections. */
const MUTUAL = /^(.+?) (?:&|and) \d+ other connections?\b/;
/** "Endorsed by Jane Doe and 2 others who are highly skilled at this". */
const ENDORSER = /^Endorsed by (.+?)(?: and \d+ others?)? (?:who|\()/;
const DEGREE_BADGE = /^·\s*(1st|2nd|3rd\+?)$/;
const YEAR = /\b(19|20)\d{2}\b/;

/** Collapses spaces but keeps line breaks: the scrubber also replaces each line on its own. */
function clean(text: string | undefined | null): string | undefined {
  const value = (text ?? "")
    .replace(/&nbsp;/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
  return value === "" ? undefined : value;
}

/** Every text node under `el`: the segments between tags, which is what the scrubber matches against. */
function leafTexts(el: HTMLElement): string[] {
  const out: string[] = [];
  const walk = (node: Node): void => {
    if (node instanceof TextNode) {
      const text = clean(node.text);
      if (text !== undefined && !/^[\d,.\s]+$/.test(text)) out.push(text);
    } else if (node instanceof HTMLElement) node.childNodes.forEach(walk);
  };
  walk(el);
  return out;
}

function collectSensitive(html: string, profile: Profile): Required<Sensitive> {
  const root = parse(html);
  const names = new Set<string>([profile.fullName]);
  const companies = new Set<string>();
  const texts = new Set<string>();
  const add = (set: Set<string>, value: string | null | undefined) => {
    const v = clean(value);
    if (v !== undefined) set.add(v);
  };

  // The owner, as the parser reads them.
  add(texts, profile.headline);
  add(texts, profile.location);
  add(texts, profile.about);
  for (const entry of profile.experience) {
    add(texts, entry.title);
    add(companies, entry.company);
    add(texts, entry.location);
    add(texts, entry.description);
  }

  // Top card: company and school chips, and the "Company · School" line.
  const card = root.querySelector(profileStructure.topCard);
  card?.querySelectorAll('[role="button"] strong, [role="button"] p').forEach((el) => {
    add(companies, el.querySelector("strong")?.text ?? el.text.replace(/\+\s*\d+\s+more$/, ""));
  });

  // Experience, beyond the five entries the parser keeps: every paragraph that is not a date.
  root.querySelectorAll(`${profileStructure.experience} p`).forEach((p) => {
    const text = clean(p.text);
    if (text !== undefined && !YEAR.test(text) && !/^(present|\d+ yrs?( \d+ mos?)?|\d+ mos?)$/i.test(text)) add(texts, text);
  });
  root.querySelectorAll(`${profileStructure.experience} img[alt]`).forEach((img) => add(texts, img.getAttribute("alt")?.replace(/^Thumbnail for /, "")));

  // Education: the school is the first paragraph of an entry, the rest is the degree or field.
  root.querySelectorAll('[data-view-name="profile-card-education"] [componentkey^="entity-collection-item"]').forEach((item) => {
    const paragraphs = item.querySelectorAll("p").map((p) => clean(p.text));
    paragraphs.forEach((text, i) => {
      if (text !== undefined && !YEAR.test(text)) add(i === 0 ? companies : texts, text);
    });
  });

  // Other people and organisations named in aria-labels.
  for (const el of root.querySelectorAll("[aria-label]")) {
    const label = clean(el.getAttribute("aria-label"));
    if (label === undefined) continue;
    for (const pattern of PERSON_LABELS) add(names, pattern.exec(label)?.[1]);
    const followed = FOLLOW_LABEL.exec(label)?.[1];
    if (followed !== undefined) add(el.closest('[data-view-name="profile-browsemap-entity"]') === null ? companies : names, followed);
    add(companies, PAGE_LABEL.exec(label)?.[1]);
    if (/ logo$/.test(label)) add(companies, label.replace(/ logo$/, ""));
  }

  // Cards of other people ("More profiles for you", "People you may know"): name, then headline.
  for (const badge of root.querySelectorAll("p").filter((p) => DEGREE_BADGE.test(clean(p.text) ?? ""))) {
    if (card?.querySelectorAll("p").includes(badge)) continue;
    let person: HTMLElement | null = badge.parentNode;
    while (person !== null && leafTexts(person).length < 3) person = person.parentNode;
    if (person === null) continue;
    const [name, ...rest] = leafTexts(person).filter((t) => !DEGREE_BADGE.test(t));
    add(names, name);
    for (const text of rest) if (!/^(connect|message|follow|pending)$/i.test(text)) add(texts, text);
  }

  // Featured: media and post titles and text the owner pinned.
  root.querySelectorAll('[data-view-name="profile-card-featured"]').forEach((featured) => {
    for (const text of leafTexts(featured)) {
      if (!/^(featured|media|post|link|article|newsletter|next|previous|\d+ (reactions?|comments?))$/i.test(text)) add(texts, text);
    }
  });

  // Interests: "<Organisation>, Company" and the organisation's name.
  root.querySelectorAll('[data-view-name="profile-card-interests"] span').forEach((span) => {
    add(companies, /^(.+), (?:Company|Group|Newsletter)$/.exec(clean(span.text) ?? "")?.[1]);
  });

  // Mutual connections and the people named in promoted cards.
  for (const text of leafTexts(root)) {
    add(names, MUTUAL.exec(text)?.[1]);
    add(names, ENDORSER.exec(text)?.[1]);
  }
  root.querySelectorAll("aside strong, [data-view-name='profile-main-level'] ~ * strong").forEach((el) => add(names, el.text));

  // Names already listed are not also texts.
  for (const name of names) texts.delete(name);
  for (const company of companies) texts.delete(company);
  return { names: [...names], companies: [...companies], texts: [...texts] };
}

/**
 * The scrubber replaces `/in/<id>` links but not ids LinkedIn also writes into
 * component keys and test ids (`profile_Skills_<id>`, `…Part7<id>`), nor member
 * URNs (`ACoA…`, `urn:li:member:<n>`), `/showcase/<slug>` pages or hashtag search links. Replace what is left so no identifier survives.
 */
function scrubIdentifiers(fixture: string, realId: string, standIn: string): string {
  const urns = new Map<string, string>();
  const urnFor = (urn: string) => {
    if (!urns.has(urn)) urns.set(urn, String(urns.size + 1).padStart(urn.length, "0"));
    return urns.get(urn) ?? urn;
  };
  const pages = new Map<string, number>();
  return fixture
    .replace(/\/showcase\/([^/?#"'\s<>&]+)/g, (_m, slug: string) => {
      if (!pages.has(slug)) pages.set(slug, pages.size + 1);
      return `/showcase/page-${pages.get(slug) ?? 0}`;
    })
    .replace(/(keywords=%23)[^"&\s]+/g, "$1hashtag")
    .split(realId)
    .join(standIn)
    .split(encodeURIComponent(realId))
    .join(standIn)
    .replace(/ACoA[A-Za-z0-9_-]{20,}/g, (urn) => `ACoA${urnFor(urn).slice(4)}`)
    .replace(/(urn(?::|%3A)li(?::|%3A)member(?::|%3A))(\d+)/g, (_m, prefix: string, id: string) => `${prefix}${urnFor(id)}`);
}

function main(): void {
  mkdirSync("fixtures/profile", { recursive: true });
  for (const { capture, fixture } of PAIRS) {
    const html = readFileSync(capture, "utf8");
    const profile = parseProfile(html);
    const sensitive = collectSensitive(html, profile);
    const scrubbed = scrubHtml(html, sensitive);
    const standIn = parseProfile(scrubbed).publicId;
    const out = scrubIdentifiers(scrubbed, profile.publicId, standIn);
    writeFileSync(fixture, out);
    console.log(
      `${fixture}: ${sensitive.names.length} names, ${sensitive.companies.length} companies, ${sensitive.texts.length} texts; ${out.length} bytes`,
    );
  }
}

main();
