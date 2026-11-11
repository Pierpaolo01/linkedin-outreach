/**
 * Selectors and interface wording for the three list pages: people search,
 * connections, sent invitations. When LinkedIn changes one of these pages,
 * this is the file to edit.
 *
 * LinkedIn's 2026 frontend hashes its class names and changes them between
 * deploys, so nothing here selects on a class. The hooks are, in order of
 * preference: `data-sdui-screen` (names the page), `data-view-name` and
 * `data-testid` (name components), roles, `href` patterns, and only where
 * nothing else exists, visible wording.
 *
 * `data-view-name` is written only into the first page a browser session loads;
 * every later load of the same page has none (seen 2026-11-11: 94 on a first
 * load, 0 on a later one). So a `data-view-name` hook is never the only way to
 * find something: `componentkey` prefixes, roles, `href` patterns and document
 * structure, all present in both variants, come with it or instead of it.
 *
 * Wording is stored in the form `normaliseText` produces: lower case,
 * straight apostrophes, single spaces. Every capture so far is English; an
 * Italian string marked `// unverified` has not been seen on a real page.
 */
import { parse, type HTMLElement } from "node-html-parser";
import { languageFromHtml, normaliseText, type InterfaceLanguage } from "../selectors";
import { ParseError, profileUrlFor } from "./card";
import { publicIdOfLink } from "./dom";

export const listStructure = {
  search: {
    /** Seen 2026-11-11 on a people search. */
    screen: "com.linkedin.sdui.flagshipnav.search.SearchResultsPeople",
    /** One result. Seen 2026-11-11 on first and later loads: the list holds only results. */
    row: '[role="listitem"]',
    /** The name link; its `p` also holds the degree ("• 3rd+"). First loads only. */
    title: '[data-view-name="search-result-lockup-title"]',
    /** The name link on any load: the first link inside a paragraph (mutual-connection links come after it). Seen 2026-11-11. */
    nameLink: "p a",
    /** Name, headline, location and summary lines are `p` elements. */
    textLine: "p",
    /** In the title's paragraph, the degree badge ("• 3rd+") is a `span` outside the name link. */
    degreeBadge: "span",
    /** Holds the row's one action (Message, Connect, Follow, Pending). First loads only. */
    action: '[data-view-name="relationship-building-button"]',
    /** Holds the action wrapper on any load: `componentkey="SearchResults<member id>"`. Seen 2026-11-11. */
    actionSlot: '[componentkey^="SearchResultsACoA"]',
    /** The control inside an action wrapper or slot. */
    control: "a, button",
    /** Any element carrying a `data-view-name`; listed in the error for an unrecognised action. */
    viewNamed: "[data-view-name]",
    /** The generated summary under the location. Later loads add mutual-connection and follower lines after it. Seen 2026-11-11. */
    snippet: '[componentkey^="SearchResultssnippet"], [id^="SearchResultssnippet"]',
    nextPage: '[data-testid="pagination-controls-next-button-visible"]',
  },
  connections: {
    /** Seen 2026-11-11 on My Network → Connections. */
    screen: "com.linkedin.sdui.flagshipnav.mynetwork.Connections",
    /** One row: `componentkey="ConnectionCard_<n>-<public id>"`. Seen 2026-11-11 on first and later loads. */
    row: '[componentkey^="ConnectionCard_"]',
    /** Two per row: the photo link (holds a `figure`) and the text link (name, headline). */
    profileLink: 'a[href*="/in/"]',
    /** Controls whose text is not part of the card: the Message link and the More actions button. */
    controls: 'a[href*="/messaging/compose/"], button',
    /** The Message link; its `recipient` is the member id. */
    composeLink: 'a[href*="/messaging/compose/"]',
    /** Name, headline and the "Connected on …" line are `p` elements. */
    textLine: "p",
  },
  sentInvitations: {
    /** Seen 2026-11-11 on My Network → Manage invitations → Sent → People. */
    screen: "com.linkedin.sdui.flagshipnav.mynetwork.invitations.InvitationSentWithType",
    row: '[role="listitem"]',
    /** The row's profile link (photo or name). */
    profileLink: 'a[href*="/in/"]',
    /** Candidate controls; one holding a `p` is the card's name link, not a control. */
    controls: "a, button",
    /** Name, headline and the "Sent …" line are `p` elements. */
    textLine: "p",
    /** First loads only; on any load the control labelled "Withdraw invitation sent to …" (wording below). */
    withdraw: '[data-view-name="sent-invitations-withdraw-single"]',
  },
} as const;

/** `data-view-name` of the component inside a search row's action, by action. */
export const searchActionViewNames = {
  /** Seen on search results. */
  message: ["message-button"],
  /** Seen on profiles and My Network, inside the same `relationship-building-button` wrapper. */
  connect: ["edge-creation-connect-action"],
  /** Seen on profiles. */
  follow: ["edge-creation-follow-action"],
  /** Not seen: a guess following the pattern above. Wording below is the fallback. */
  pending: ["edge-creation-pending-action", "edge-creation-withdraw-action"],
} as const;

/** The CSS selector for any of an action's `data-view-name`s. */
export function searchActionSelector(action: keyof typeof searchActionViewNames): string {
  return searchActionViewNames[action].map((name) => `[data-view-name="${name}"]`).join(", ");
}

export interface ListWording {
  readonly search: {
    /** Shown instead of results when the search matches no one. */
    readonly noResults: readonly string[];
    /** The monthly commercial-use search limit notice. No capture yet in either language. */
    readonly capped: readonly string[];
    /** The name shown for out-of-network members whose profile is hidden. */
    readonly hiddenMember: readonly string[];
    /** Degree badge, after the leading bullet: "3rd+" → 3. */
    readonly degree: RegExp;
    /** Start of an action's `aria-label` or text, used when its `data-view-name` is unknown. */
    readonly action: {
      readonly message: readonly string[];
      readonly connect: readonly string[];
      readonly follow: readonly string[];
      readonly pending: readonly string[];
    };
    /** Label of an older-style "Current: <role> at <company>" summary line. */
    readonly currentLabel: RegExp;
  };
  readonly connections: {
    readonly empty: readonly string[];
    /** "Connected on <date>"; group 1 is the date. */
    readonly connectedOn: RegExp;
    readonly months: readonly (readonly string[])[];
    /** Date order within the date text. */
    readonly dateOrder: "month-day-year" | "day-month-year";
  };
  readonly sentInvitations: {
    readonly empty: readonly string[];
    /** The "Sent 4 months ago" line. */
    readonly sent: RegExp;
    /** Start of the withdraw control's `aria-label` or text. */
    readonly withdraw: readonly string[];
  };
}

const byLanguage = {
  en: {
    search: {
      noResults: ["no results found"], // unverified
      capped: [
        // unverified: no capture of the cap yet
        "you've reached the monthly limit for profile searches",
        "you've reached the commercial use limit on search",
        "commercial use limit",
      ],
      hiddenMember: ["linkedin member"], // unverified
      degree: /^(?:•\s*)?(1st|2nd|3rd\+?)$/,
      action: {
        message: ["send a message to", "message"],
        connect: ["invite", "connect"],
        follow: ["follow"],
        pending: ["pending", "withdraw invitation"], // unverified
      },
      currentLabel: /^current:\s*(.+?)\s+at\s+(.+)$/, // unverified
    },
    connections: {
      empty: ["you don't have any connections yet", "no connections yet"], // unverified
      connectedOn: /^connected (?:on )?(.+)$/,
      months: [
        ["january", "jan"],
        ["february", "feb"],
        ["march", "mar"],
        ["april", "apr"],
        ["may"],
        ["june", "jun"],
        ["july", "jul"],
        ["august", "aug"],
        ["september", "sep", "sept"],
        ["october", "oct"],
        ["november", "nov"],
        ["december", "dec"],
      ],
      dateOrder: "month-day-year",
    },
    sentInvitations: {
      empty: ["no pending invitations", "you have no pending invitations", "no sent invitations"], // unverified
      sent: /^sent\b/,
      withdraw: ["withdraw"],
    },
  },
  it: {
    search: {
      noResults: ["nessun risultato trovato"], // unverified
      capped: [
        "hai raggiunto il limite mensile per le ricerche di profili", // unverified
        "hai raggiunto il limite di uso commerciale", // unverified
        "limite di uso commerciale", // unverified
      ],
      hiddenMember: ["utente linkedin"], // unverified
      degree: /^(?:•\s*)?([123])°\+?$/, // unverified
      action: {
        message: ["invia un messaggio a", "messaggio"], // unverified
        connect: ["invita", "collegati"], // unverified
        follow: ["segui"], // unverified
        pending: ["in sospeso", "ritira l'invito"], // unverified
      },
      currentLabel: /^attuale:\s*(.+?)\s+presso\s+(.+)$/, // unverified
    },
    connections: {
      empty: ["non hai ancora nessun collegamento", "nessun collegamento"], // unverified
      connectedOn: /^(?:collegat[oaie]|collegamento effettuato) il (.+)$/, // unverified
      months: [
        ["gennaio", "gen"],
        ["febbraio", "feb"],
        ["marzo", "mar"],
        ["aprile", "apr"],
        ["maggio", "mag"],
        ["giugno", "giu"],
        ["luglio", "lug"],
        ["agosto", "ago"],
        ["settembre", "set"],
        ["ottobre", "ott"],
        ["novembre", "nov"],
        ["dicembre", "dic"],
      ],
      dateOrder: "day-month-year",
    },
    sentInvitations: {
      empty: ["nessun invito in sospeso", "non hai inviti in sospeso", "nessun invito inviato"], // unverified
      sent: /^inviat[oa]\b/, // unverified
      withdraw: ["ritira"], // unverified
    },
  },
} as const satisfies Record<InterfaceLanguage, ListWording>;

export function listWordingFor(language: InterfaceLanguage): ListWording {
  return byLanguage[language];
}

// Helpers the three list parsers share: how the hooks above are applied.

export interface ListPage {
  readonly root: HTMLElement;
  /** The element carrying the page's `data-sdui-screen`. */
  readonly screen: HTMLElement;
  readonly language: InterfaceLanguage;
  readonly wording: ListWording;
}

/** Parses saved HTML and checks it is the expected page; `ParseError` otherwise. */
export function loadListPage(html: string, page: string, screenId: string): ListPage {
  const root = parse(html);
  // Bundled strings must not count as notices on the page.
  for (const element of root.querySelectorAll("script, style, noscript, template")) element.remove();
  const screen = root.querySelector(`[data-sdui-screen="${screenId}"]`);
  if (screen === null) throw new ParseError(page, `not the ${page} page: no data-sdui-screen "${screenId}"`);
  const language = languageFromHtml(html);
  return { root, screen, language, wording: listWordingFor(language) };
}

/** Visible text with whitespace collapsed, case kept. */
export function textOf(element: HTMLElement): string {
  return element.text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function startsWithAny(text: string, phrases: readonly string[]): boolean {
  const normalised = normaliseText(text);
  return phrases.some((phrase) => normalised.startsWith(phrase));
}

export function includesAny(text: string, phrases: readonly string[]): boolean {
  const normalised = normaliseText(text);
  return phrases.some((phrase) => normalised.includes(phrase));
}

/** The card's identity from a profile link; `ParseError` naming the row when the link is missing or not a profile. */
export function identityFrom(
  link: HTMLElement | null,
  page: string,
  rowLabel: string,
): { readonly publicId: string; readonly profileUrl: string } {
  const publicId = link === null ? undefined : publicIdOfLink(link);
  if (publicId === undefined) throw new ParseError(page, `${rowLabel}: no profile link`);
  return { publicId, profileUrl: profileUrlFor(publicId) };
}

/** Options every list parser takes. */
export interface ListParseOptions {
  /** The user's own public identifier: a card for him is never returned. */
  readonly selfPublicId?: string;
}
