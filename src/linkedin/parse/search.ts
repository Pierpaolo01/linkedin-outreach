/**
 * Parses a saved people-search results page (linkedin.com/search/results/people/).
 * Pure: saved HTML in, typed cards out.
 */
import type { HTMLElement } from "node-html-parser";
import { ParseError, type Card } from "./card";
import { isInside } from "./dom";
import {
  identityFrom,
  includesAny,
  listStructure,
  loadListPage,
  searchActionSelector,
  startsWithAny,
  textOf,
  type ListParseOptions,
  type ListWording,
} from "./selectors.lists";

const PAGE = "search";
const hooks = listStructure.search;

/** The one action a result row offers. */
export const SEARCH_ACTIONS = ["message", "connect", "follow", "pending"] as const;
export type SearchAction = (typeof SEARCH_ACTIONS)[number];

export interface SearchCard extends Card {
  /** The row's action button. Null when the row shows none. */
  readonly action: SearchAction | null;
  /** The line under the location (2026: a generated "<role> at <company> since …" summary). Null when absent. */
  readonly summary: string | null;
}

export interface SearchResults {
  readonly cards: readonly SearchCard[];
  readonly hasNextPage: boolean;
  /** LinkedIn's monthly commercial-use search limit notice is on the page. */
  readonly capped: boolean;
  /** Rows for out-of-network members LinkedIn hides ("LinkedIn Member", no profile link). */
  readonly hiddenMembers: number;
  /**
   * Results that could not be read and are left out of `cards`, each as which one and why
   * ("result 7: no profile link"). Fewer than half the page's results, or the parse fails.
   */
  readonly skipped: readonly string[];
}

export interface SearchParseOptions extends ListParseOptions {
  /**
   * Fail on any result that cannot be read instead of leaving it out. For building fixtures: a
   * result left out would keep its person's name and headline in the fixture, unscrubbed.
   */
  readonly everyResult?: boolean;
}

export function parseSearchResults(html: string, options: SearchParseOptions = {}): SearchResults {
  const { root, screen, wording } = loadListPage(html, PAGE, hooks.screen);
  const pageText = textOf(root);
  const capped = includesAny(pageText, wording.search.capped);

  const cards: SearchCard[] = [];
  const skipped: string[] = [];
  let hiddenMembers = 0;
  const rows = screen.querySelectorAll(hooks.row);
  rows.forEach((result, index) => {
    const card = readRow(result, `result ${index + 1}`, wording);
    if (card === "hidden") hiddenMembers += 1;
    else if ("unreadable" in card) skipped.push(card.unreadable);
    else if (card.publicId !== options.selfPublicId) cards.push(card);
  });
  // One odd result is LinkedIn's variety and is left out; half the page or more is a page that changed.
  if (skipped[0] !== undefined && (options.everyResult === true || skipped.length * 2 >= rows.length)) {
    throw new ParseError(PAGE, `${skipped[0]} (${skipped.length} of ${rows.length} results could not be read)`);
  }

  if (cards.length === 0 && hiddenMembers === 0 && !capped && !includesAny(pageText, wording.search.noResults)) {
    throw new ParseError(PAGE, "no result rows and no 'no results' notice");
  }

  return { cards, hasNextPage: root.querySelector(hooks.nextPage) !== null, capped, hiddenMembers, skipped };
}

/** A result's card, "hidden" for a hidden member, or which result could not be read and why. */
function readRow(result: HTMLElement, label: string, wording: ListWording): SearchCard | "hidden" | { readonly unreadable: string } {
  try {
    return parseRow(result, label, wording);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    return { unreadable: error.message.slice(`${PAGE}: `.length) };
  }
}

function parseRow(result: HTMLElement, label: string, wording: ListWording): SearchCard | "hidden" {
  const title = result.querySelector(hooks.title) ?? result.querySelector(hooks.nameLink);
  const fullName = title === null ? "" : textOf(title);
  if (title === null || title.getAttribute("href") === undefined) {
    if (includesAny(textOf(result), wording.search.hiddenMember)) return "hidden";
  }
  if (title === null) throw new ParseError(PAGE, `${label}: no name link`);
  const identity = identityFrom(title, PAGE, label);
  if (fullName === "") throw new ParseError(PAGE, `${label}: no name`);

  // The title's paragraph holds the name and the degree badge; its parent holds headline then location.
  const titleLine = title.closest(hooks.textLine) ?? title.parentNode;
  if (titleLine === null) throw new ParseError(PAGE, `${label}: name link outside any line`);
  const details = titleLine.parentNode ?? titleLine;
  const actionWrapper = result.querySelector(hooks.action) ?? actionSlotOf(result);
  const outsideAction = (p: HTMLElement) => actionWrapper === null || !isInside(p, actionWrapper);

  const [headline, location] = details
    .querySelectorAll(hooks.textLine)
    .filter((p) => p !== titleLine && outsideAction(p))
    .map(textOf);
  const snippet = result.querySelector(hooks.snippet);
  const summaryLines =
    snippet === null
      ? result.querySelectorAll(hooks.textLine).filter((p) => !isInside(p, details) && outsideAction(p))
      : snippet.querySelectorAll(hooks.textLine);
  const summary =
    summaryLines
      .map(textOf)
      .filter((text) => text !== "")
      .join(" ") || null;

  return {
    ...identity,
    fullName,
    headline: headline || null,
    location: location || null,
    company: summary === null ? null : companyFrom(summary, wording),
    degree: degreeOf(titleLine, title, wording),
    action: actionWrapper === null ? null : actionOf(actionWrapper, label, wording),
    summary,
  };
}

/** The action slot of a later page load, when it holds a control; null for a row with no action. */
function actionSlotOf(result: HTMLElement): HTMLElement | null {
  const slot = result.querySelector(hooks.actionSlot);
  return slot !== null && slot.querySelector(hooks.control) !== null ? slot : null;
}

/** The company from an older-style "Current: <role> at <company>" line, in its original case. */
function companyFrom(summary: string, wording: ListWording): string | null {
  const match = wording.search.currentLabel.exec(summary.toLowerCase());
  if (match?.[2] === undefined) return null;
  return summary.slice(summary.length - match[2].length).trim();
}

function degreeOf(titleLine: HTMLElement, title: HTMLElement, wording: ListWording): Card["degree"] {
  for (const span of titleLine.querySelectorAll(hooks.degreeBadge)) {
    if (isInside(span, title)) continue;
    const match = wording.search.degree.exec(textOf(span).toLowerCase());
    const digit = match?.[1]?.[0];
    if (digit === "1") return 1;
    if (digit === "2") return 2;
    if (digit === "3") return 3;
  }
  return null;
}

function actionOf(wrapper: HTMLElement, label: string, wording: ListWording): SearchAction {
  for (const action of SEARCH_ACTIONS) {
    if (wrapper.querySelector(searchActionSelector(action)) !== null) return action;
  }
  const control = wrapper.querySelector(hooks.control);
  if (control === null) throw new ParseError(PAGE, `${label}: action area with no control`);
  const text = control.getAttribute("aria-label") ?? textOf(control);
  // Pending first: its wording ("withdraw invitation") must win over the others.
  for (const action of ["pending", "connect", "follow", "message"] as const) {
    if (startsWithAny(text, wording.search.action[action])) return action;
  }
  const viewNames = wrapper
    .querySelectorAll(hooks.viewNamed)
    .map((element) => element.getAttribute("data-view-name"))
    .join(", ");
  throw new ParseError(PAGE, `${label}: unrecognised action (data-view-name: ${viewNames || "none"})`);
}
