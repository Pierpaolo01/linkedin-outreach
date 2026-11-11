/**
 * Parses My Network → Grow (https://www.linkedin.com/mynetwork/grow/), the recommendations page,
 * into groups of cards. Pure: saved or live HTML in, typed data out.
 */
import { parse, type HTMLElement } from "node-html-parser";
import { languageFromHtml, normaliseText } from "../selectors";
import { linkedInUrl, ParseError, profileUrlFor, type Card } from "./card";
import { firstProfileLink, inlineText, isInside } from "./dom";
import {
  recommendationsStructural as s,
  recommendationsWordingFor,
  type RecommendationAction,
  type RecommendationsWording,
} from "./selectors.recommendations";

export type { RecommendationAction } from "./selectors.recommendations";

const PAGE = "My Network → Grow";

export interface RecommendationCard extends Card {
  /** Title of the group the card was shown in. */
  readonly group: string;
  /** The line under the headline, as shown: mutual connections, a shared company or school, "Based on your profile". */
  readonly insight: string | null;
  readonly action: RecommendationAction;
}

interface GroupHeader {
  /** The heading as shown, e.g. "People you may know from <company>" or "Suggestions for you". */
  readonly title: string;
  /** The company, school or place the heading names, when it names one. */
  readonly reason: string | null;
  /** The heading has a "Show all" control next to it. */
  readonly hasShowAll: boolean;
}

/** Only people who can be invited are `people`; received invitations and non-person suggestions are `other`, without cards. */
export type RecommendationGroup =
  | (GroupHeader & { readonly kind: "people"; readonly cards: readonly RecommendationCard[] })
  | (GroupHeader & { readonly kind: "other"; readonly cards: readonly [] });

export interface RecommendationsResult {
  readonly groups: readonly RecommendationGroup[];
}

export interface ParseRecommendationsOptions {
  /** The signed-in user's public id, never returned as a card. Read from the global navigation when it links to his profile. */
  readonly signedInPublicId?: string;
}

/** Throws `ParseError` when the page is not My Network → Grow or a group or card cannot be read. */
export function parseRecommendations(html: string, options: ParseRecommendationsOptions = {}): RecommendationsResult {
  const root = parse(html);
  const main = root.querySelector(s.main);
  if (main === null || !isGrowPage(main)) {
    throw new ParseError(PAGE, "not the My Network → Grow page (no current Grow tab in the page content)");
  }
  const sections = groupSections(main);
  if (sections.length === 0) throw new ParseError(PAGE, "no groups found (no section holding a list)");

  const wording = recommendationsWordingFor(languageFromHtml(html));
  const signedIn = options.signedInPublicId ?? signedInFromNav(root);
  return { groups: sections.map((section, index) => readGroup({ section, groupNumber: index + 1, wording, signedIn })) };
}

/** The people cards across groups, de-duplicated by public id; each keeps the group it first appeared in. */
export function flattenRecommendations(result: RecommendationsResult): RecommendationCard[] {
  const byId = new Map<string, RecommendationCard>();
  for (const group of result.groups) {
    if (group.kind !== "people") continue;
    for (const card of group.cards) if (!byId.has(card.publicId)) byId.set(card.publicId, card);
  }
  return [...byId.values()];
}

function isGrowPage(main: HTMLElement): boolean {
  return main.querySelectorAll(s.currentTab).some((a) => pathOf(a.getAttribute("href")) === s.growPath);
}

function groupSections(main: HTMLElement): HTMLElement[] {
  const sections: HTMLElement[] = [];
  for (const list of main.querySelectorAll(s.list)) {
    const section = list.closest(s.section);
    if (section !== null && !sections.includes(section)) sections.push(section);
  }
  return sections;
}

function signedInFromNav(root: HTMLElement): string | undefined {
  return firstProfileLink(root.querySelector(s.signedInNav)?.querySelectorAll(s.link) ?? [])?.publicId;
}

interface GroupInput {
  readonly section: HTMLElement;
  readonly groupNumber: number;
  readonly wording: RecommendationsWording;
  readonly signedIn: string | undefined;
}

function readGroup({ section, groupNumber, wording, signedIn }: GroupInput): RecommendationGroup {
  const heading = section.querySelector(s.heading);
  if (heading === null) throw new ParseError(PAGE, `group ${groupNumber} has no heading`);
  const title = inlineText(heading);
  if (title === "") throw new ParseError(PAGE, `group ${groupNumber} has an empty heading`);
  const header: GroupHeader = {
    title,
    reason: reasonFrom(title, wording),
    hasShowAll: (heading.parentNode?.querySelectorAll(s.headerControl).length ?? 0) > 0,
  };

  const items = section.querySelectorAll(s.card);
  if (isReceivedInvitations(section) || !items.some((item) => isInvitablePerson(item, wording))) {
    return { ...header, kind: "other", cards: [] };
  }
  const cards = items
    .map((item, index) => readCard({ item, where: `group ${groupNumber} card ${index + 1}`, group: title, wording }))
    .filter((card) => card.publicId !== signedIn);
  return { ...header, kind: "people", cards };
}

function isReceivedInvitations(section: HTMLElement): boolean {
  return section.querySelectorAll(s.link).some((a) => pathOf(a.getAttribute("href")) === s.invitationManagerPath);
}

function isInvitablePerson(item: HTMLElement, wording: RecommendationsWording): boolean {
  const action = actionOf(item, wording);
  return profileLink(item) !== undefined && (action === "connect" || action === "pending");
}

interface CardInput {
  readonly item: HTMLElement;
  readonly where: string;
  readonly group: string;
  readonly wording: RecommendationsWording;
}

function readCard({ item, where, group, wording }: CardInput): RecommendationCard {
  const link = profileLink(item);
  if (link === undefined) throw new ParseError(PAGE, `${where} has no profile link`);
  const [nameLine, headlineLine] = link.element.querySelectorAll(s.textLine).map(inlineText);
  if (nameLine === undefined || nameLine === "") throw new ParseError(PAGE, `${where} has no name`);
  const action = actionOf(item, wording);
  if (action === undefined) throw new ParseError(PAGE, `${where} has no Connect, Follow or Pending button`);
  const insight = item
    .querySelectorAll(s.textLine)
    .filter((p) => !isInside(p, link.element) && p.closest(s.button) === null)
    .map(inlineText)
    .find((text) => text !== "");

  return {
    publicId: link.publicId,
    profileUrl: profileUrlFor(link.publicId),
    fullName: nameLine,
    headline: headlineLine === undefined || headlineLine === "" ? null : headlineLine,
    location: null,
    company: null,
    degree: null,
    group,
    insight: insight ?? null,
    action,
  };
}

function profileLink(item: HTMLElement): { element: HTMLElement; publicId: string } | undefined {
  return firstProfileLink(item.querySelectorAll(s.link));
}

/** The action is the card's one button with visible text; the dismiss button carries an icon only. */
function actionOf(item: HTMLElement, wording: RecommendationsWording): RecommendationAction | undefined {
  for (const button of item.querySelectorAll(s.button)) {
    const text = normaliseText(button.text);
    if (text === "") continue;
    for (const action of ["connect", "follow", "pending"] as const) {
      if (wording.actions[action].includes(text)) return action;
    }
  }
  return undefined;
}

function reasonFrom(title: string, wording: RecommendationsWording): string | null {
  const normalised = normaliseText(title);
  const prefix = wording.reasonPrefixes.find((p) => normalised.startsWith(p));
  if (prefix === undefined) return null;
  const reason = title.slice(prefix.length).trim();
  return reason === "" ? null : reason;
}

function pathOf(href: string | undefined): string | undefined {
  return href === undefined ? undefined : linkedInUrl(href)?.pathname;
}
