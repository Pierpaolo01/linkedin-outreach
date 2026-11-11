/**
 * Parses a saved My Network → Connections page (linkedin.com/mynetwork/invite-connect/connections/),
 * sorted by recently added. Pure: saved HTML in, typed cards out.
 */
import type { HTMLElement } from "node-html-parser";
import { normaliseText } from "../selectors";
import { memberIdFromComposeHref, ParseError, type Card } from "./card";
import {
  identityFrom,
  includesAny,
  isInside,
  listStructure,
  loadListPage,
  textOf,
  type ListParseOptions,
  type ListWording,
} from "./selectors.lists";

const PAGE = "connections";
const COMPOSE_LINK = 'a[href*="/messaging/compose/"]';
const hooks = listStructure.connections;

export interface ConnectionCard extends Card {
  readonly degree: 1;
  /** The "Connected on …" line as shown. Null when the row has none. */
  readonly connectedOnText: string | null;
  /** The connection date as `YYYY-MM-DD`, when the line gives an absolute date. Null for relative or unrecognised text. */
  readonly connectedOn: string | null;
  /** The member id in the row's Message link; `readThread` needs it. Null when the row has no such link. */
  readonly memberId: string | null;
}

export function parseConnections(html: string, options: ListParseOptions = {}): ConnectionCard[] {
  const { root, screen, wording } = loadListPage(html, PAGE, hooks.screen);
  const rows = screen.querySelectorAll(hooks.row);
  if (rows.length === 0 && !includesAny(textOf(root), wording.connections.empty)) {
    throw new ParseError(PAGE, "no connection rows and no empty-list notice");
  }
  return rows
    .map((row, index) => parseRow(row, `connection ${index + 1}`, wording))
    .filter((card) => card.publicId !== options.selfPublicId);
}

function parseRow(row: HTMLElement, label: string, wording: ListWording): ConnectionCard {
  const links = row.querySelectorAll(hooks.profileLink).filter((element) => element.tagName === "A");
  const identity = identityFrom(links[0] ?? null, PAGE, label);
  const textLink = links.find((link) => link.querySelector("p") !== null);
  const [name, headline] = (textLink?.querySelectorAll("p") ?? []).map(textOf);
  if (textLink === undefined || !name) throw new ParseError(PAGE, `${label}: no name`);

  const controls = row.querySelectorAll(hooks.controls);
  const connectedOnText =
    row
      .querySelectorAll("p")
      .filter((p) => !isInside(p, textLink) && !controls.some((control) => isInside(p, control)))
      .map(textOf)
      .find((text) => text !== "") ?? null;

  return {
    ...identity,
    fullName: name,
    headline: headline || null,
    location: null,
    company: null,
    degree: 1,
    connectedOnText,
    connectedOn: connectedOnText === null ? null : dateFrom(connectedOnText, wording),
    memberId: memberIdFromComposeHref(row.querySelector(COMPOSE_LINK)?.getAttribute("href")),
  };
}

/** An absolute date in the "Connected on …" line as `YYYY-MM-DD`; null for anything else. */
function dateFrom(text: string, wording: ListWording): string | null {
  const { connectedOn, months, dateOrder } = wording.connections;
  const date = connectedOn.exec(normaliseText(text))?.[1]?.replace(/\.$/, "");
  if (date === undefined) return null;
  const parts =
    dateOrder === "month-day-year"
      ? /^(?<month>\p{L}+)\.? (?<day>\d{1,2}),? (?<year>\d{4})$/u.exec(date)?.groups
      : /^(?<day>\d{1,2}) (?<month>\p{L}+)\.? (?<year>\d{4})$/u.exec(date)?.groups;
  if (parts?.month === undefined || parts.day === undefined || parts.year === undefined) return null;
  const monthName = parts.month;
  const month = months.findIndex((names) => names.includes(monthName)) + 1;
  const day = Number(parts.day);
  const year = Number(parts.year);
  if (month === 0) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${parts.year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
