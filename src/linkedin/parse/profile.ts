/**
 * Parses a saved profile page into what `viewProfile` returns: who the
 * person is, what they do (the evidence scoring needs: title, company,
 * about, experience, location) and where the invite step stands.
 *
 * Pure: saved HTML in, typed data out. Everything about the owner is read
 * inside the top card, so the signed-in user's own name in the navigation is
 * never taken for the owner's.
 */
import { parse, HTMLElement, TextNode, type Node } from "node-html-parser";
import { languageFromHtml, normaliseText } from "../selectors";
import { ParseError, profileUrlFor, publicIdFromUrl } from "./card";
import { MAX_EXPERIENCE, profileStructure as s, profileWording, type ProfileWording } from "./selectors.profile";

/** One role as the profile's Experience section shows it. */
export interface ExperienceEntry {
  readonly title: string;
  readonly company: string | null;
  /** As shown, e.g. "Jan 1984 - Present · 42 yrs 11 mos". */
  readonly dateRange: string | null;
  /** The date range ends in "Present". */
  readonly current: boolean;
  readonly location: string | null;
  readonly description: string | null;
}

export interface Profile {
  /** The `<id>` in linkedin.com/in/<id>. Identifies the person. */
  readonly publicId: string;
  /** Canonical: https://www.linkedin.com/in/<id>/ with no query string. */
  readonly profileUrl: string;
  readonly fullName: string;
  readonly headline: string | null;
  readonly location: string | null;
  /** 1, 2 or 3 (3 covers "3rd+"). Null when the page shows no degree. */
  readonly degree: 1 | 2 | 3 | null;
  /** The About text in full, line breaks kept. Null when the profile has none. */
  readonly about: string | null;
  /** Title and company of the newest current role. Null when no shown role is current. */
  readonly currentTitle: string | null;
  readonly currentCompany: string | null;
  /** The roles the page shows, newest first, at most five. */
  readonly experience: readonly ExperienceEntry[];
  readonly connectionState: ConnectionState;
  /** The top card offers Message (to a 1st-degree connection, or an open profile / InMail). */
  readonly messageAvailable: boolean;
}

/**
 * Where the invite step stands, as far as the saved markup shows:
 * - `can_connect`: a Connect button is in the top card.
 * - `connect_in_more`: Connect is an item of the More menu, and the menu is rendered in the markup.
 * - `pending`: an invitation was already sent.
 * - `connected`: 1st degree, Message is offered and there is no Connect.
 * - `follow_only`: no Connect anywhere in the markup. LinkedIn renders the More
 *   menu only once it is clicked, so Connect may still be inside it: the invite
 *   step has to open More before it concludes Connect is not offered.
 * - `unknown`: the top card holds none of the actions above.
 */
export type ConnectionState = "can_connect" | "connect_in_more" | "pending" | "connected" | "follow_only" | "unknown";

const PAGE = "profile";

/** LinkedIn's page for a profile that does not exist, was removed, or is hidden from the user. */
export class ProfileUnavailableError extends ParseError {
  constructor() {
    super(PAGE, "profile not available");
    this.name = "ProfileUnavailableError";
  }
}

export function parseProfile(html: string): Profile {
  const wording = profileWording[languageFromHtml(html)];
  const root = parse(html);
  const card = root.querySelector(s.topCard);
  if (card === null) {
    if (isUnavailablePage(root, wording)) throw new ProfileUnavailableError();
    throw new ParseError(PAGE, "no top card: not a profile page");
  }

  const nameHeading = card.querySelector(`${s.nameBadge} h2`) ?? card.querySelector("h2");
  const fullName = textOf(nameHeading);
  if (fullName === null) throw new ParseError(PAGE, "top card has no name");

  const publicId = ownerPublicId(root, card);
  if (publicId === undefined) throw new ParseError(PAGE, "top card has no profile link");

  const experience = experienceOf(root, wording);
  const current = experience.find((entry) => entry.current);
  const degree = degreeOf(card, wording);
  const actions = actionsOf(card, wording);
  return {
    publicId,
    profileUrl: profileUrlFor(publicId),
    fullName,
    headline: nameHeading === null ? null : headlineAfter(nameHeading, wording),
    location: locationOf(card),
    degree,
    about: aboutOf(root),
    currentTitle: current?.title ?? null,
    currentCompany: current?.company ?? null,
    experience,
    connectionState: connectionStateOf(actions, degree),
    messageAvailable: actions.message,
  };
}

function isUnavailablePage(root: HTMLElement, wording: ProfileWording): boolean {
  const headings = root.querySelectorAll("h1, h2, h3, title").map((h) => normaliseText(h.text));
  return headings.some((heading) => wording.unavailable.some((phrase) => heading.includes(phrase)));
}

interface TopCardActions {
  readonly connect: boolean;
  readonly connectInMenu: boolean;
  readonly pending: boolean;
  readonly follow: boolean;
  readonly message: boolean;
}

/** What the top card offers. Only the top card: other people's cards on the page carry their own Connect buttons. */
function actionsOf(card: HTMLElement, wording: ProfileWording): TopCardActions {
  const controls = card.querySelectorAll('button, a, [role="menuitem"]');
  const inMenu = (el: HTMLElement) => el.closest(s.menu) !== null;
  const primary = controls.filter((el) => !inMenu(el));
  const menu = controls.filter(inMenu);
  const says = (words: readonly string[]) => (el: HTMLElement) => controlSays(el, words);
  const notInMenu = (selector: string) => card.querySelectorAll(selector).some((el) => !inMenu(el));

  const messageLinks = card.querySelectorAll(`${s.message} a, ${s.message} button`);
  return {
    connect: notInMenu(s.connectAction) || primary.some(says(wording.connect)),
    connectInMenu: menu.some(says(wording.connect)),
    pending: card.querySelector(s.pendingAction) !== null || primary.some(says(wording.pending)),
    follow: notInMenu(s.followAction) || primary.some(says(wording.follow)),
    message:
      messageLinks.some((el) => el.getAttribute("aria-disabled") !== "true") ||
      primary.some((el) => el.getAttribute("aria-disabled") !== "true" && says(wording.message)(el)),
  };
}

/** A control's visible text is one of the words, or its aria-label starts with one ("Invite X to connect"). */
function controlSays(el: HTMLElement, words: readonly string[]): boolean {
  const text = normaliseText(el.text);
  const aria = normaliseText(el.getAttribute("aria-label") ?? "");
  return words.some((w) => text === w || aria === w || aria.startsWith(`${w} `) || aria.startsWith(`${w},`));
}

function connectionStateOf(actions: TopCardActions, degree: Profile["degree"]): ConnectionState {
  if (actions.pending) return "pending";
  if (actions.connect) return "can_connect";
  if (actions.connectInMenu) return "connect_in_more";
  if (degree === 1 && actions.message) return "connected";
  if (actions.follow) return "follow_only";
  return "unknown";
}

function aboutOf(root: HTMLElement): string | null {
  const section = root.querySelector(s.about);
  if (section === null) return null;
  const box = section.querySelector(s.expandableText);
  if (box !== null) return blockText(box);
  const paragraphs = section.querySelectorAll("p").map(blockText).filter((t) => t !== null);
  return paragraphs.length === 0 ? null : paragraphs.join("\n");
}

function experienceOf(root: HTMLElement, wording: ProfileWording): ExperienceEntry[] {
  const section = root.querySelector(s.experience);
  if (section === null) return [];
  const entries: ExperienceEntry[] = [];
  for (const item of section.querySelectorAll(s.experienceItem)) {
    const roles = item.querySelectorAll("ul > li");
    if (roles.length > 0) {
      // A company with several roles: the item's first paragraph is the company, each `li` a role.
      const company = textOf(ownParagraphs(item).find((p) => p.closest("li") === null));
      for (const li of roles) {
        const entry = roleOf(li, wording, { companyInRole: false });
        if (entry !== null) entries.push({ ...entry, company });
      }
    } else {
      const entry = roleOf(item, wording, { companyInRole: true });
      if (entry !== null) entries.push(entry);
    }
  }
  return entries.slice(0, MAX_EXPERIENCE);
}

/**
 * A role's paragraphs come in order: title, company (outside a group), date
 * range, then optional location and description. A paragraph holding just
 * "Present" is a badge, not a location.
 */
function roleOf(el: HTMLElement, wording: ProfileWording, o: { readonly companyInRole: boolean }): ExperienceEntry | null {
  const paragraphs = ownParagraphs(el);
  const title = textOf(paragraphs[0]);
  if (title === null) return null;
  const dateIndex = paragraphs.findIndex((p, i) => i > 0 && isDateRange(p.text));
  const dateRange = dateIndex === -1 ? null : textOf(paragraphs[dateIndex]);
  const company = o.companyInRole && dateIndex !== 1 ? companyName(textOf(paragraphs[1])) : null;

  const description = el.querySelector(s.expandableText);
  const rest = paragraphs.slice(dateIndex === -1 ? (o.companyInRole ? 2 : 1) : dateIndex + 1);
  const location = rest.find((p) => {
    const text = textOf(p);
    return text !== null && p.querySelector(s.expandableText) === null && !isPresentWord(text, wording);
  });
  return {
    title,
    company,
    dateRange,
    current: dateRange !== null && endsInPresent(dateRange, wording),
    location: textOf(location),
    description: description === null ? null : blockText(description),
  };
}

/** Paragraphs that belong to the role itself, not to a media thumbnail inside it. */
function ownParagraphs(el: HTMLElement): HTMLElement[] {
  return el.querySelectorAll("p").filter((p) => p.closest(s.experienceMedia) === null);
}

/** "Old Company · Full-time" → "Old Company". */
function companyName(text: string | null): string | null {
  return text === null ? null : (text.split(" · ")[0]?.trim() ?? null);
}

function isDateRange(text: string): boolean {
  return /\b\d{4}\b/.test(text) && /\s[-–—]\s/.test(text);
}

function endsInPresent(dateRange: string, wording: ProfileWording): boolean {
  const end = dateRange.split(" · ")[0]?.split(/\s[-–—]\s/)[1];
  return end !== undefined && isPresentWord(end, wording);
}

function isPresentWord(text: string, wording: ProfileWording): boolean {
  return wording.present.includes(normaliseText(text));
}

/** The owner's id: from the Contact info link in the top card, else the sticky header's profile link. */
function ownerPublicId(root: HTMLElement, card: HTMLElement): string | undefined {
  const contact = card.querySelector(s.contactInfoLink)?.getAttribute("href");
  const fromContact = contact === undefined ? undefined : publicIdFromUrl(contact.replace(/overlay\/contact-info\/?.*$/, ""));
  if (fromContact !== undefined) return fromContact;
  for (const link of root.querySelectorAll(s.stickyHeaderLink)) {
    const id = publicIdFromUrl(link.getAttribute("href") ?? "");
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * The headline is the first paragraph after the name that is not the degree
 * badge. The name sits a few wrappers deep, so walk up until a following
 * sibling paragraph turns up.
 */
function headlineAfter(name: HTMLElement, wording: ProfileWording): string | null {
  for (let el: HTMLElement | null = name; el !== null && el.rawTagName !== "section"; el = el.parentNode) {
    for (let sibling = el.nextElementSibling; sibling !== null; sibling = sibling.nextElementSibling) {
      if (sibling.rawTagName !== "p") continue;
      const text = textOf(sibling);
      if (text !== null && degreeFromText(text, wording) === null) return text;
    }
  }
  return null;
}

/** The location is the first paragraph of the row that holds the Contact info link. */
function locationOf(card: HTMLElement): string | null {
  const row = card.querySelector(s.contactInfoLink)?.closest("p")?.parentNode;
  const first = row?.querySelector("p");
  if (first === null || first === undefined || first.querySelector(s.contactInfoLink) !== null) return null;
  return textOf(first);
}

function degreeOf(card: HTMLElement, wording: ProfileWording): 1 | 2 | 3 | null {
  for (const p of card.querySelectorAll("p")) {
    const degree = degreeFromText(p.text, wording);
    if (degree !== null) return degree;
  }
  return null;
}

function degreeFromText(text: string, wording: ProfileWording): 1 | 2 | 3 | null {
  const label = normaliseText(text).replace(/^·\s*/, "");
  return Object.hasOwn(wording.degrees, label) ? (wording.degrees[label] ?? null) : null;
}

/** Text of a paragraph with its line breaks kept, without the "… more" toggle. Null when empty. */
function blockText(el: HTMLElement): string | null {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node instanceof TextNode) parts.push(node.text.replace(/\s+/g, " "));
    else if (node instanceof HTMLElement) {
      if (node.rawTagName === "br") parts.push("\n");
      else if (node.getAttribute("data-testid") !== "expandable-text-button") node.childNodes.forEach(walk);
    }
  };
  walk(el);
  const text = parts
    .join("")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === "" ? null : text;
}

/** Visible text of an element, whitespace collapsed. Null when empty. */
function textOf(el: HTMLElement | null | undefined): string | null {
  if (el === null || el === undefined) return null;
  const text = el.text.replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}
