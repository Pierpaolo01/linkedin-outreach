/**
 * NOT VERIFIED ON THE LIVE SITE: this checks saved pages only.
 *
 * Pages for the write-operation tests, built from committed fixtures. Used by the tests only.
 *
 * The saved profile and messaging pages are real captures, scrubbed. What happens after a click is
 * not in any capture: dialogs come from the invented `fixtures/write/synthetic-*` fragments, laid
 * over a saved page, and the few changes a click makes to a saved page (Connect becomes Pending, a
 * message is added to a conversation) are made here, each an assumption listed in
 * docs/research/write-operations.md.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "node-html-parser";
import { parseThread } from "../parse/thread";
import { thread as threadHooks } from "../parse/selectors.thread";

/** Not verified on the live site. */
export function fixture(path: string): string {
  return readFileSync(join(process.cwd(), "fixtures", path), "utf8");
}

/** The body of a `fixtures/write/synthetic-*` fragment. Not verified on the live site. */
export function fragment(name: string): string {
  const html = fixture(`write/${name}`);
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1];
  if (body === undefined) throw new Error(`no body in ${name}`);
  return body;
}

/** The page with a fragment (a dialog or menu) shown on top, as LinkedIn adds it at the end of the body. Not verified on the live site. */
export function overlay(page: string, name: string): string {
  const at = page.lastIndexOf("</body>");
  if (at === -1) throw new Error("no </body>");
  return `${page.slice(0, at)}${fragment(name)}${page.slice(at)}`;
}

/** The person the saved 2nd-degree profile shows (`fixtures/profile/not-connected-later-en.html`). */
export const PROFILE_PERSON = { publicId: "person-1", memberId: "ACoA00000000000000000000000000000000001" } as const;
export const CONNECT_PROFILE = "profile/not-connected-later-en.html";
export const PROFILE_URL = "https://www.linkedin.com/in/person-1/";

const CONNECT_LINK = /<a [^>]*href="\/preload\/custom-invite\/[^"]*"[^>]*>[\s\S]*?<\/a>/g;
const FOLLOW_BUTTON = /<button [^>]*aria-label="Follow Person 1"[^>]*>[\s\S]*?<\/button>/g;

/**
 * The profile after the invitation went out. Assumption (research note, 8): the Connect control
 * (or, where Connect was under More, the Follow button) is replaced by a Pending button whose
 * aria-label starts "Pending, click to withdraw".
 * Not verified on the live site.
 */
export function asPending(profile: string, label = "Pending, click to withdraw invitation sent to Person 1", text = "Pending"): string {
  const pending = `<button type="button" aria-label="${label}"><span>${text}</span></button>`;
  const replaced = profile.includes("/preload/custom-invite/") ? profile.replace(CONNECT_LINK, pending) : profile.replace(FOLLOW_BUTTON, pending);
  if (replaced === profile) throw new Error("no Connect link or Follow button to replace");
  return replaced;
}

/** The saved 3rd-degree profile: Message, Follow and More in the top card, no Connect. */
export const FOLLOW_PROFILE = "profile/not-connected-a-en.html";

/** The profile with no Connect in its top card (Connect only under More): the Connect links removed. Not verified on the live site. */
export function withoutConnect(profile: string): string {
  return profile.replace(CONNECT_LINK, "");
}

/**
 * The saved English profile as an Italian interface would show it: `lang="it"` and Italian labels
 * on Connect, Message and More. Assumption (research note, 13): the Italian wording.
 * Not verified on the live site.
 */
export function italianProfile(profile: string): string {
  return profile
    .replace('<html lang="en"', '<html lang="it"')
    .replaceAll('aria-label="Invite Person 1 to connect"', 'aria-label="Invita Person 1 a collegarsi"')
    .replaceAll(">Connect</span>", ">Collegati</span>")
    .replaceAll(">More</span>", ">Altro</span>")
    .replaceAll(">Message</span>", ">Messaggio</span>")
    .replaceAll(">Follow</span>", ">Segui</span>")
    .replaceAll('aria-label="Follow Person 1"', 'aria-label="Segui Person 1"');
}

/** The saved conversation of a connection, opened by the compose URL. Its scrubbed member id is "person-1". */
export const COMPOSE_EXISTING = "messaging/compose-existing-en.html";
export const COMPOSE_PERSON = { publicId: "person-1-vanity", memberId: "person-1" } as const;
/** Not verified on the live site. */
export function composeUrl(memberId: string): string {
  const url = new URL("https://www.linkedin.com/messaging/compose/");
  url.searchParams.set("profileUrn", `urn:li:fsd_profile:${memberId}`);
  url.searchParams.set("recipient", memberId);
  return url.href;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The conversation with one more message at the end, a copy of the last message of that sender
 * that starts a group (name and profile link), with the text replaced. Assumption (research note,
 * 11): a sent message is drawn like the earlier ones, its text as typed.
 * Not verified on the live site.
 */
export function withMessage(page: string, sender: "user" | "participant", text: string): string {
  const root = parse(page);
  const pane = root.querySelector(threadHooks.pane);
  if (pane === null) throw new Error("no conversation pane");
  const senders = parseThread(page).messages.map((m) => m.sender);
  const elements = pane.querySelectorAll(threadHooks.listEvent).flatMap((li) => li.querySelectorAll(threadHooks.message));
  const template = elements.findLast(
    (el, index) => senders[index] === sender && el.querySelector(threadHooks.groupMeta) !== null,
  );
  if (template === undefined) throw new Error(`no message from the ${sender} to copy`);
  const copy = parse(template.outerHTML);
  const body = copy.querySelector(threadHooks.body);
  if (body === null) throw new Error("no message body");
  body.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
  const events = pane.querySelectorAll(threadHooks.listEvent);
  const last = events.at(-1);
  if (last === undefined) throw new Error("no message list");
  last.insertAdjacentHTML("afterend", `<li class="msg-s-message-list__event clearfix">${copy.toString()}</li>`);
  return root.toString();
}

/** A draft left in the conversation's message box. Not verified on the live site. */
export function withDraft(page: string, draft: string): string {
  const box = /(<div class="msg-form__contenteditable[^"]*"[^>]*>)<p><br><\/p>/;
  if (!box.test(page)) throw new Error("no empty message box");
  return page.replace(box, `$1<p>${escapeHtml(draft)}</p>`);
}

/**
 * The conversation with a message form added, as the saved Italian synthetic conversation has none.
 * Assumption (research note, 13): the Italian Send button reads "Invia".
 * Not verified on the live site.
 */
export function withMessageForm(page: string, send = "Invia"): string {
  const root = parse(page);
  const pane = root.querySelector(threadHooks.pane);
  if (pane === null) throw new Error("no conversation pane");
  pane.insertAdjacentHTML(
    "beforeend",
    `<form class="msg-form"><div class="msg-form__msg-content-container"><div class="msg-form__contenteditable" contenteditable="true" role="textbox" aria-multiline="true"><p><br></p></div></div><footer class="msg-form__footer"><button class="msg-form__send-button artdeco-button" type="submit">${send}</button></footer></form>`,
  );
  return root.toString();
}

/** The saved sent-invitations page: two rows, person-1 and person-2, each with Withdraw. */
export const SENT_PAGE = "invitations/sent-en.html";
export const SENT_URL = "https://www.linkedin.com/mynetwork/invitation-manager/sent/";

/** The list without this person's row. Assumption (research note, 10): a withdrawn invitation's row goes. Not verified on the live site. */
export function withoutRow(page: string, publicId: string): string {
  const root = parse(page);
  const rows = root.querySelectorAll('[role="listitem"]').filter((row) => row.querySelector(`a[href*="/in/${publicId}/"]`) !== null);
  if (rows.length === 0) throw new Error(`no row for ${publicId}`);
  for (const row of rows) row.remove();
  return root.toString();
}

/** The saved sent-invitations page as an Italian interface would label it. Assumption (research note, 13). Not verified on the live site. */
export function italianSentPage(page: string): string {
  return page
    .replace('<html lang="en"', '<html lang="it"')
    .replaceAll(/aria-label="Withdraw invitation sent to ([^"]+)"/g, 'aria-label="Ritira invito inviato a $1"')
    .replaceAll(">Withdraw</span>", ">Ritira</span>");
}
