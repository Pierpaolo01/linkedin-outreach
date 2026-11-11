/**
 * Parses a saved sent-invitations page
 * (linkedin.com/mynetwork/invitation-manager/sent/, People tab). Pure: saved HTML in, typed cards out.
 */
import type { HTMLElement } from "node-html-parser";
import { normaliseText } from "../selectors";
import { ParseError, type Card } from "./card";
import { isInside } from "./dom";
import {
  identityFrom,
  includesAny,
  listStructure,
  loadListPage,
  startsWithAny,
  textOf,
  type ListParseOptions,
  type ListWording,
} from "./selectors.lists";

const PAGE = "sent invitations";
const hooks = listStructure.sentInvitations;

export interface SentInvitationCard extends Card {
  /** The "Sent 4 months ago" line as shown. Null when the row has none. */
  readonly sentText: string | null;
  /** The row has a Withdraw control. */
  readonly canWithdraw: boolean;
}

export function parseSentInvitations(html: string, options: ListParseOptions = {}): SentInvitationCard[] {
  const { root, screen, wording } = loadListPage(html, PAGE, hooks.screen);
  const rows = screen.querySelectorAll(hooks.row);
  if (rows.length === 0 && !includesAny(textOf(root), wording.sentInvitations.empty)) {
    throw new ParseError(PAGE, "no invitation rows and no empty-list notice");
  }
  return rows
    .map((row, index) => parseRow(row, `invitation ${index + 1}`, wording))
    .filter((card) => card.publicId !== options.selfPublicId);
}

function parseRow(row: HTMLElement, label: string, wording: ListWording): SentInvitationCard {
  const identity = identityFrom(row.querySelector(hooks.profileLink), PAGE, label);
  const controls = row.querySelectorAll(hooks.controls).filter((control) => control.querySelector(hooks.textLine) === null);
  const withdraw = row.querySelector(hooks.withdraw);
  const canWithdraw =
    withdraw !== null ||
    controls.some((control) => startsWithAny(control.getAttribute("aria-label") ?? textOf(control), wording.sentInvitations.withdraw));

  // Text lines in order: name, then headline and the sent line, each optional.
  const [name, ...others] = row
    .querySelectorAll(hooks.textLine)
    .filter((p) => !controls.some((control) => isInside(p, control)))
    .map(textOf);
  if (!name) throw new ParseError(PAGE, `${label}: no name`);
  const rest = others.filter((text) => text !== "");
  const isSentLine = (text: string) => wording.sentInvitations.sent.test(normaliseText(text));
  const sentText = rest.find(isSentLine) ?? (rest.length >= 2 ? (rest.at(-1) ?? null) : null);
  const headline = rest.find((text) => text !== sentText) ?? null;

  return { ...identity, fullName: name, headline, location: null, company: null, degree: null, sentText, canWithdraw };
}
