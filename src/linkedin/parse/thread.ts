/**
 * Parsers for the messaging page: the open conversation (`parseThread`), the conversation
 * list on the left (`parseConversationList`) and the open conversation's URL (`findThreadUrl`).
 *
 * Safety property: before a step is sent, the engine must know whether the prospect replied or
 * the user wrote to them himself. So the sender of every message is either proven by the page
 * or the parse fails with `ParseError`. It is never guessed.
 */
import { parse, type HTMLElement, type Node } from "node-html-parser";
import { languageFromHtml, normaliseText } from "../selectors";
import { ParseError, profileUrlFor, publicIdFromUrl } from "./card";
import { conversationList, thread, threadUrl, threadWordingFor, type ThreadWording } from "./selectors.thread";

export type ConversationKind = "message" | "inmail" | "sponsored" | "unknown";
export type Sender = "user" | "participant";

export interface Participant {
  readonly fullName: string;
  /** The line under the name in the title bar, or null when there is none. */
  readonly headline: string | null;
  /**
   * The `<id>` of the profile link the page shows, or null when it links none. On the messaging
   * page this is the member id form (`ACoAA…`), not the vanity id used on profile pages;
   * `profileUrl` still opens the profile. In a new conversation (`isNew`) it is the vanity id.
   */
  readonly publicId: string | null;
  readonly profileUrl: string | null;
}

export interface Message {
  readonly sender: Sender;
  readonly senderName: string;
  /** InMail subject line, when the message has one. */
  readonly subject: string | null;
  readonly text: string;
  /** Day heading and time as shown, for example "Today 1:29 PM" or "Mar 3, 2025 10:02 AM". */
  readonly sentAtRaw: string;
  /** Local time, only when the page shows an absolute date with a year and a time. */
  readonly sentAt: Date | null;
}

export interface Thread {
  readonly participant: Participant;
  readonly kind: ConversationKind;
  /** Oldest first. Empty for a new conversation. */
  readonly messages: readonly Message[];
  /**
   * True for LinkedIn's "New message" pane: there is no conversation with this person yet. The
   * participant's `publicId` is then the vanity id of their profile, not the member id.
   */
  readonly isNew: boolean;
}

export interface ConversationSummary {
  readonly participantName: string;
  /** Snippet as shown, including a "You:" or "<first name>:" prefix, without the InMail pill. */
  readonly snippet: string;
  readonly timeRaw: string;
  readonly unread: boolean;
  readonly kind: ConversationKind;
  /**
   * Who the snippet says wrote last: "user" for the "You:" prefix, "participant" for the
   * participant's first name as prefix, null when the snippet has no prefix (LinkedIn omits
   * it in some conversations, so null says nothing either way).
   */
  readonly snippetSender: Sender | null;
  readonly threadUrl: string | null;
}

const PAGE = "messaging";

function loadMessagingPage(html: string): HTMLElement {
  const root = parse(html);
  if (root.querySelector(thread.messagingPage) === null) {
    throw new ParseError(PAGE, "not the messaging page (no conversation list or conversation pane)");
  }
  return root;
}

/** Visible text: HTML whitespace collapsed, `<br>` and block boundaries as newlines. */
function visibleText(element: HTMLElement): string {
  const blocks = new Set(["p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]);
  let out = "";
  const softBreak = () => {
    if (out !== "" && !out.endsWith("\n")) out += "\n";
  };
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out += node.text.replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== 1 || !isElement(node)) return;
    const tag = node.rawTagName.toLowerCase();
    if (tag === "br") {
      out += "\n";
      return;
    }
    const block = blocks.has(tag);
    if (block) softBreak();
    for (const child of node.childNodes) walk(child);
    if (block) softBreak();
  };
  for (const child of element.childNodes) walk(child);
  return out
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === 1 && "rawTagName" in node;
}

/** Single-line text of an element, whitespace collapsed. */
function inlineText(element: HTMLElement | null): string {
  return element === null ? "" : element.text.replace(/\s+/g, " ").trim();
}

function sameName(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== "" && normaliseText(a) === normaliseText(b);
}

interface UserIdentity {
  /** Member id of the mailbox owner, from the message URNs. */
  readonly profileId: string | null;
  /** Full name from the "Me" menu photo. */
  readonly name: string | null;
}

function identifyUser(root: HTMLElement, messages: readonly HTMLElement[]): UserIdentity {
  const owners = new Set<string>();
  for (const message of messages) {
    const urn = message.getAttribute(thread.eventUrnAttribute);
    const owner = urn === undefined ? undefined : thread.mailboxOwnerFromEventUrn.exec(urn)?.[1];
    if (owner !== undefined) owners.add(owner);
  }
  if (owners.size > 1) throw new ParseError(PAGE, "messages name more than one mailbox owner");
  const alt = root.querySelector(thread.mePhoto)?.getAttribute("alt")?.trim();
  return { profileId: [...owners][0] ?? null, name: alt === undefined || alt === "" ? null : alt };
}

function parseParticipant(pane: HTMLElement): Participant {
  const titleBar = pane.querySelector(thread.titleBar);
  const fullName = inlineText(titleBar?.querySelector(thread.participantName) ?? null);
  if (titleBar === null || fullName === "") throw new ParseError(PAGE, "no conversation is open");
  const href = titleBar.querySelector(thread.participantLink)?.getAttribute("href");
  const publicId = href === undefined ? undefined : publicIdFromUrl(href);
  const headline = inlineText(titleBar.querySelector(thread.participantHeadline));
  return {
    fullName,
    headline: headline === "" ? null : headline,
    publicId: publicId ?? null,
    profileUrl: publicId === undefined ? null : profileUrlFor(publicId),
  };
}

/**
 * Who sent the first message of a group. Each signal the page offers casts a vote; at least one
 * vote is needed and all votes must agree.
 */
function groupSender(message: HTMLElement, participant: Participant, user: UserIdentity, index: number): Sender {
  const votes = new Set<Sender>();
  const linkIds = new Set(
    message
      .querySelectorAll(thread.senderLinks)
      .map((a) => publicIdFromUrl(a.getAttribute("href") ?? ""))
      .filter((id): id is string => id !== undefined),
  );
  if (linkIds.size > 1) throw new ParseError(PAGE, `message ${index + 1} links more than one profile as its sender`);
  const linkId = [...linkIds][0];
  if (linkId !== undefined) {
    if (linkId === user.profileId) votes.add("user");
    else if (linkId === participant.publicId) votes.add("participant");
    else if (user.profileId !== null && participant.publicId !== null) {
      throw new ParseError(PAGE, `message ${index + 1} was sent by someone who is neither the user nor the participant`);
    }
  }
  const name = inlineText(message.querySelector(thread.groupName));
  const isUserName = sameName(name, user.name);
  const isParticipantName = sameName(name, participant.fullName);
  if (isUserName !== isParticipantName) votes.add(isUserName ? "user" : "participant");

  const [sender, ...rest] = [...votes];
  if (sender === undefined) throw new ParseError(PAGE, `cannot tell who sent message ${index + 1}`);
  if (rest.length > 0) throw new ParseError(PAGE, `the page contradicts itself on who sent message ${index + 1}`);
  return sender;
}

function isGroupStart(message: HTMLElement): boolean {
  return message.querySelector(thread.groupMeta) !== null || message.querySelector(thread.senderLinks) !== null;
}

const TIME = /(\d{1,2})[:.](\d{2})\s*([ap])?\.?\s*m?\.?/i;

/** Resolves "Mar 3, 2025" / "3 mar 2025" plus "10:02 AM" / "10:02". Null when anything is relative or missing. */
function resolveSentAt(day: string, time: string, wording: ThreadWording): Date | null {
  const tokens = normaliseText(day).replace(/[,.]/g, " ").split(" ").filter(Boolean);
  if (tokens.length !== 3) return null;
  const year = tokens.find((t) => /^\d{4}$/.test(t));
  const date = tokens.find((t) => /^\d{1,2}$/.test(t));
  const monthWord = tokens.find((t) => /^\p{L}+$/u.test(t));
  const month = wording.months.findIndex((prefixes) => prefixes.some((p) => monthWord?.startsWith(p) === true));
  const clock = TIME.exec(time);
  if (year === undefined || date === undefined || month === -1 || clock === null) return null;
  let hours = Number(clock[1]);
  const minutes = Number(clock[2]);
  const meridiem = clock[3]?.toLowerCase();
  if (meridiem !== undefined) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  }
  if (hours > 23 || minutes > 59) return null;
  const result = new Date(Number(year), month, Number(date), hours, minutes);
  return result.getDate() === Number(date) && result.getMonth() === month ? result : null;
}

export function parseThread(html: string): Thread {
  const root = loadMessagingPage(html);
  const pane = root.querySelector(thread.pane);
  if (pane === null) throw new ParseError(PAGE, "no conversation is open");
  const fresh = parseNewConversation(pane);
  if (fresh !== null) return fresh;
  const participant = parseParticipant(pane);
  const wording = threadWordingFor(languageFromHtml(html));

  const events = pane.querySelectorAll(thread.listEvent);
  const user = identifyUser(root, events.flatMap((li) => li.querySelectorAll(thread.message)));

  const messages: Message[] = [];
  let day = "";
  let kind: ConversationKind = "unknown";
  let group: { sender: Sender; senderName: string; time: string } | null = null;
  for (const li of events) {
    const heading = li.querySelector(thread.dayHeading);
    if (heading !== null) day = inlineText(heading);
    for (const element of li.querySelectorAll(thread.message)) {
      const index = messages.length;
      if (isGroupStart(element)) {
        const sender = groupSender(element, participant, user, index);
        const shownName = inlineText(element.querySelector(thread.groupName));
        group = {
          sender,
          senderName: shownName || (sender === "user" ? (user.name ?? "") : participant.fullName),
          time: inlineText(element.querySelector(thread.groupTime)),
        };
      } else if (group === null) {
        throw new ParseError(PAGE, "the first message has no sender name or profile link");
      }
      // A message without name and avatar continues the group above it.
      const { sender, senderName } = group;
      const time = inlineText(element.querySelector(thread.groupTime)) || group.time;
      const fromOther = element.classList.contains(thread.fromOtherClass);
      if (fromOther !== (sender === "participant")) {
        throw new ParseError(PAGE, `the page contradicts itself on who sent message ${index + 1}`);
      }

      if (element.classList.contains(thread.inmailClass)) kind = "inmail";
      else if (element.classList.contains(thread.sponsoredClass)) kind = kind === "inmail" ? kind : "sponsored";
      else if (kind === "unknown") kind = "message";

      const subject = inlineText(element.querySelector(thread.subject));
      const body = element.querySelector(thread.body);
      messages.push({
        sender,
        senderName,
        subject: subject === "" ? null : subject,
        text: body === null ? "" : visibleText(body),
        sentAtRaw: [day, time].filter(Boolean).join(" "),
        sentAt: resolveSentAt(day, time, wording),
      });
    }
  }
  return { participant, kind, messages, isNew: false };
}

/**
 * The "New message" pane addressed to exactly one person, or null when the pane is something else.
 * Fails closed: several recipients, a missing profile link, or any rendered message is not a new
 * one-to-one conversation.
 */
function parseNewConversation(pane: HTMLElement): Thread | null {
  const pills = pane.querySelectorAll(thread.newRecipientPill);
  if (pills.length === 0) return null;
  if (pills.length > 1) throw new ParseError(PAGE, "a new message addressed to several people");
  if (pane.querySelector(thread.listEvent) !== null) throw new ParseError(PAGE, "a new message pane that shows messages");
  const fullName = inlineText(pills[0]?.querySelector(thread.newRecipientName) ?? null);
  const ids = new Set(
    pane
      .querySelectorAll(thread.newProfileCardLink)
      .map((link) => publicIdFromUrl(link.getAttribute("href") ?? ""))
      .filter((id) => id !== undefined),
  );
  const [publicId] = ids;
  if (fullName === "" || publicId === undefined || ids.size !== 1) {
    throw new ParseError(PAGE, "a new message pane that does not name one person");
  }
  return {
    participant: { fullName, headline: null, publicId, profileUrl: profileUrlFor(publicId) },
    kind: "unknown",
    messages: [],
    isNew: true,
  };
}

/** Canonical thread URL from a relative or absolute link, or null when it is not one. */
function threadUrlFrom(href: string | undefined): string | null {
  if (href === undefined) return null;
  let url: URL;
  try {
    url = new URL(href, "https://www.linkedin.com");
  } catch {
    return null;
  }
  if (url.hostname !== "www.linkedin.com" && url.hostname !== "linkedin.com") return null;
  const id = threadUrl.path.exec(url.pathname)?.[1];
  return id === undefined || id === "new" ? null : threadUrlForId(id);
}

function threadUrlForId(id: string): string {
  return `https://www.linkedin.com/messaging/thread/${id}/`;
}

/** Text of an element without the parts matched by `exclude`, whitespace collapsed. */
function textWithout(element: HTMLElement, exclude: string): string {
  const skipped = new Set(element.querySelectorAll(exclude));
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === 3) out += node.text;
    else if (isElement(node) && !skipped.has(node)) node.childNodes.forEach(walk);
  };
  element.childNodes.forEach(walk);
  return out.replace(/\s+/g, " ").trim();
}

function kindFromLabel(label: string, wording: ThreadWording): ConversationKind {
  const normalised = normaliseText(label);
  if (normalised === "") return "message";
  if (wording.inmailLabels.includes(normalised)) return "inmail";
  if (wording.sponsoredLabels.includes(normalised)) return "sponsored";
  return "unknown";
}

function snippetSender(snippet: string, participantName: string, wording: ThreadWording): Sender | null {
  const normalised = normaliseText(snippet);
  if (wording.userSnippetPrefixes.some((prefix) => normalised.startsWith(prefix))) return "user";
  const fullName = normaliseText(participantName);
  const firstName = fullName.split(" ")[0] ?? "";
  const prefixes = [fullName, firstName].filter((name) => name !== "").map((name) => `${name}:`);
  return prefixes.some((prefix) => normalised.startsWith(prefix)) ? "participant" : null;
}

/** The conversation list on the left, top first. Rows the virtualised list has not rendered are left out. */
export function parseConversationList(html: string): ConversationSummary[] {
  const root = loadMessagingPage(html);
  const container = root.querySelector(conversationList.container);
  if (container === null) throw new ParseError(PAGE, "no conversation list");
  const wording = threadWordingFor(languageFromHtml(html));

  const summaries: ConversationSummary[] = [];
  for (const item of container.querySelectorAll(conversationList.item)) {
    const card = item.querySelector(conversationList.card);
    if (item.classList.contains(conversationList.occludedClass) && card === null) continue;
    if (card === null) throw new ParseError(PAGE, `conversation ${summaries.length + 1} has no card`);
    const participantName = inlineText(card.querySelector(conversationList.names));
    if (participantName === "") throw new ParseError(PAGE, `conversation ${summaries.length + 1} has no name`);
    const snippetElement = card.querySelector(conversationList.snippet);
    const snippet = snippetElement === null ? "" : textWithout(snippetElement, `${conversationList.pill}, ${conversationList.pillDot}`);
    summaries.push({
      participantName,
      snippet,
      timeRaw: inlineText(card.querySelector(conversationList.time)),
      unread: card.querySelector(conversationList.unread) !== null,
      kind: kindFromLabel(inlineText(card.querySelector(conversationList.pill)), wording),
      snippetSender: snippetSender(snippet, participantName, wording),
      threadUrl: threadUrlFrom(item.querySelector(threadUrl.link)?.getAttribute("href")),
    });
  }
  return summaries;
}

/**
 * The open conversation's URL (`https://www.linkedin.com/messaging/thread/<id>/`) when the saved
 * markup holds it: a canonical link, the active list card's link, or a link or conversation URN in
 * the conversation pane. Null when it holds none of these (the case on the real page seen
 * 2026-11-11, where the live URL lives only in the address bar).
 */
export function findThreadUrl(html: string): string | null {
  const root = loadMessagingPage(html);
  const fromHead =
    threadUrlFrom(root.querySelector("link[rel='canonical']")?.getAttribute("href")) ??
    threadUrlFrom(root.querySelector("meta[property='og:url']")?.getAttribute("content"));
  if (fromHead !== null) return fromHead;

  const active = root.querySelector(conversationList.activeItem);
  if (active !== null) {
    const fromActive =
      threadUrlFrom(active.getAttribute("href")) ?? threadUrlFrom(active.querySelector(threadUrl.link)?.getAttribute("href"));
    if (fromActive !== null) return fromActive;
  }

  const pane = root.querySelector(thread.pane);
  if (pane === null) return null;
  const fromPaneLink = threadUrlFrom(pane.querySelector(threadUrl.link)?.getAttribute("href"));
  if (fromPaneLink !== null) return fromPaneLink;
  for (const element of [pane, ...pane.querySelectorAll("*")]) {
    for (const value of Object.values(element.attributes)) {
      const id = threadUrl.conversationUrn.exec(value)?.[1];
      if (id !== undefined) return threadUrlForId(id);
    }
  }
  return null;
}
