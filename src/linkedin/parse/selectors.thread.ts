/**
 * Selectors and wording for the messaging page (https://www.linkedin.com/messaging/).
 *
 * This page still runs LinkedIn's older frontend: `#global-nav` and `msg-*` class names,
 * stable for years. The newer pages use hashed class names; if messaging moves to that
 * frontend, this is the file to rewrite. Seen on a real capture 2026-11-11 (English).
 *
 * Wording is stored lower-case with straight apostrophes, the form `normaliseText` produces.
 */
import type { InterfaceLanguage } from "../selectors";

export const thread = {
  /** Either half of the messaging page. The `msg-overlay-*` chat bubble appears on every page and is not one of these. */
  messagingPage: ".msg-conversations-container__conversations-list, .msg-convo-wrapper",

  /** The open conversation, on the right. */
  pane: ".msg-convo-wrapper",
  titleBar: ".msg-title-bar",
  participantName: ".msg-entity-lockup__entity-title",
  participantHeadline: ".msg-entity-lockup__entity-info",
  /** Links the participant's profile as /in/<member id> (the ACoAA… form, not the vanity id). */
  participantLink: "a.msg-thread__link-to-profile",

  /** One per rendered message, in page order (oldest first). Day headings sit inside them. */
  listEvent: "li.msg-s-message-list__event",
  /** "Today", "Mar 3, 2025": applies to every message after it until the next heading. */
  dayHeading: "time.msg-s-message-list__time-heading",
  message: ".msg-s-event-listitem",
  /** Name and time; present only on the first message of a group of consecutive messages from one sender. */
  groupMeta: ".msg-s-message-group__meta",
  groupName: ".msg-s-message-group__name",
  groupTime: ".msg-s-message-group__timestamp",
  /** The avatar link and the name link of a group's first message. */
  senderLinks: "a.msg-s-event-listitem__link, .msg-s-message-group__meta a",
  body: ".msg-s-event-listitem__body",
  /** InMail subject line. */
  subject: ".msg-s-event-listitem__subject",

  /** Class LinkedIn puts on messages not sent by the signed-in user. Used only to veto, never to decide. */
  fromOtherClass: "msg-s-event-listitem--other",
  inmailClass: "msg-s-event-listitem--inmail",
  // unverified: not seen on a real page
  sponsoredClass: "msg-s-event-listitem--sponsored",

  /**
   * `urn:li:msg_message:(urn:li:fsd_profile:<mailbox owner>,<message id>)`. The mailbox owner is the
   * signed-in user on every message, whoever sent it (seen on an incoming InMail).
   */
  eventUrnAttribute: "data-event-urn",
  mailboxOwnerFromEventUrn: /^urn:li:msg_message:\(urn:li:fsd_profile:([^,)]+),/,

  /** The signed-in user's photo in the "Me" menu; its `alt` is the user's full name. */
  mePhoto: "#global-nav img.global-nav__me-photo",
} as const;

export const conversationList = {
  container: ".msg-conversations-container__conversations-list",
  item: "li.msg-conversation-listitem",
  /** Placeholder rows outside the rendered window of the virtualised list. They hold no data. */
  occludedClass: "msg-conversation-card--occluded",
  card: ".msg-conversation-card",
  names: ".msg-conversation-card__participant-names",
  time: "time.msg-conversation-card__time-stamp",
  snippet: ".msg-conversation-card__message-snippet",
  /** "InMail" pill and its separator dot, inside the snippet. */
  pill: ".msg-conversation-card__pill",
  pillDot: ".msg-conversation-card__message-label-dot",
  unread: ".msg-conversation-card__unread-count, .msg-conversation-card__message-snippet--unread",
  activeItem: ".msg-conversations-container__convo-item-link--active",
} as const;

export const threadUrl = {
  /** `/messaging/thread/<id>/`, relative or absolute. */
  path: /\/messaging\/thread\/([^/?#"'\s]+)\/?/,
  link: "a[href*='/messaging/thread/']",
  /** `urn:li:msg_conversation:(urn:li:fsd_profile:<owner>,<thread id>)`. */
  conversationUrn: /urn:li:msg_conversation:\(urn:li:fsd_profile:[^,]+,([^)]+)\)/,
} as const;

export interface ThreadWording {
  /** Snippet prefix when the last message in a conversation is the user's ("You: …"). */
  readonly userSnippetPrefixes: readonly string[];
  readonly inmailLabels: readonly string[];
  readonly sponsoredLabels: readonly string[];
  /** Month-name prefixes, January first, for absolute day headings. */
  readonly months: readonly (readonly string[])[];
}

const byLanguage = {
  en: {
    userSnippetPrefixes: ["you:"],
    inmailLabels: ["inmail"],
    // unverified: not seen on a real page
    sponsoredLabels: ["sponsored"],
    months: [
      ["jan"], ["feb"], ["mar"], ["apr"], ["may"], ["jun"],
      ["jul"], ["aug"], ["sep"], ["oct"], ["nov"], ["dec"],
    ],
  },
  it: {
    // unverified: Italian strings below were not seen on a real page
    userSnippetPrefixes: ["tu:"],
    inmailLabels: ["inmail"],
    sponsoredLabels: ["sponsorizzato", "sponsorizzata"],
    months: [
      ["gen"], ["feb"], ["mar"], ["apr"], ["mag"], ["giu"],
      ["lug"], ["ago"], ["set"], ["ott"], ["nov"], ["dic"],
    ],
  },
} as const satisfies Record<InterfaceLanguage, ThreadWording>;

export function threadWordingFor(language: InterfaceLanguage): ThreadWording {
  return byLanguage[language];
}
