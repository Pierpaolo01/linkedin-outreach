/**
 * NOT VERIFIED ON THE LIVE SITE. Built against saved conversations only; nothing here has typed
 * into or sent from the real message box. docs/research/write-operations.md lists what to check
 * before the first real message. Not wired into the app: the worker keeps its read-only driver.
 *
 * `sendMessage`: open the conversation by the compose URL (decision 16), make sure it is the person
 * asked for, compare the messages shown with the count the caller judged, type, compare again,
 * click Send (never Enter), and return "sent" only once the conversation ends with the text.
 */
import type { MessageResult, PersonRef, SendGuard } from "../driver";
import { parseThread, type Thread } from "../parse/thread";
import { sameText } from "../../engine/threadCheck";
import { giveUp, openPage, pastDeadline, readPage, timeoutOf, tryParse, wordingOf, type WriteDeps } from "./common";
import type { Target } from "./page";
import { writeStructure } from "./selectors.write";

const ORIGIN = "https://www.linkedin.com";
const MESSAGE_BOX: Target = { roles: ["textbox"], within: writeStructure.messageForm };

/** The URL that opens the conversation with one member (decision 16, `readThread` loads the same). Not verified on the live site. */
export function composeUrlFor(memberId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(memberId)) throw new RangeError("not a member id");
  const url = new URL(`${ORIGIN}/messaging/compose/`);
  url.searchParams.set("profileUrn", `urn:li:fsd_profile:${memberId}`);
  url.searchParams.set("recipient", memberId);
  return url.href;
}

/**
 * The conversation shown is with this person, by the same rule `readThread` applies: LinkedIn
 * opens the newest conversation when it cannot open the one asked for. A conversation names the
 * person by member id once they have written; before that, the address bar must still be the
 * compose URL for that member (and, in a new conversation, its profile card the public id).
 * Not verified on the live site.
 */
export function isConversationWith(person: PersonRef, thread: Thread, pageUrl: string): boolean {
  const shown = thread.participant.publicId;
  const stillComposing = thread.viaCompose && new URL(pageUrl).searchParams.get("recipient") === person.memberId;
  return shown === null ? stillComposing : shown === person.memberId || (shown === person.publicId && stillComposing);
}

/**
 * NOT VERIFIED ON THE LIVE SITE. Sends `text` to a 1st-degree connection.
 *
 * Order: deadline, open, confirm the person, clear any draft, compare the count, deadline, type,
 * check the box holds the text, compare the count and the deadline again, click Send, wait for the
 * conversation to end with the user's message of that text. A changed count returns
 * "thread_changed" and a passed deadline "expired", the box cleared in both. Types and clicks
 * nothing when the conversation is not with the person asked for. Throws `Unexpected`, with the
 * page saved, on anything it does not recognise; after the click a throw means the result is not
 * known.
 */
export async function sendMessage(
  deps: WriteDeps,
  person: PersonRef,
  text: string,
  expected: SendGuard & { readonly messageCount: number },
): Promise<MessageResult> {
  const { page } = deps;
  if (pastDeadline(page, expected)) return "expired";

  const url = composeUrlFor(person.memberId);
  const html = await openPage(deps, url);
  const before = await readPage(deps, html, parseThread);
  if (!isConversationWith(person, before, page.url())) return giveUp(deps, "the conversation shown is not with the person asked for");
  if ((await page.count(MESSAGE_BOX)) === 0) return giveUp(deps, "the conversation has no message box");
  const send: Target = { roles: ["button"], name: wordingOf(html).sendMessage, within: writeStructure.messageForm };
  if ((await page.count(send)) === 0) return giveUp(deps, "the conversation has no Send button");

  if ((await page.value(MESSAGE_BOX)).trim() !== "") {
    await page.clear(MESSAGE_BOX);
    if ((await page.value(MESSAGE_BOX)).trim() !== "") return giveUp(deps, "the draft in the message box could not be cleared");
  }
  if (before.messages.length !== expected.messageCount) return "thread_changed";
  if (pastDeadline(page, expected)) return "expired";

  await page.type(MESSAGE_BOX, text);
  if (!sameText(await page.value(MESSAGE_BOX), text)) {
    await page.clear(MESSAGE_BOX);
    return giveUp(deps, "the message box does not hold the text as typed; nothing was sent");
  }

  // Immediately before Send: the conversation as it is now, and the clock.
  const now = await readPage(deps, await page.content(), parseThread);
  if (!isConversationWith(person, now, page.url())) {
    await page.clear(MESSAGE_BOX);
    return giveUp(deps, "the conversation changed to another person while typing");
  }
  if (now.messages.length !== expected.messageCount) return clearAnd(deps, "thread_changed");
  if (pastDeadline(page, expected)) return clearAnd(deps, "expired");

  await page.click(send);
  const lastBefore = now.messages.at(-1);
  const sameAsBefore = lastBefore !== undefined && lastBefore.sender === "user" && sameText(lastBefore.text, text);
  const appeared = await page.waitFor((shown) => {
    const after = tryParse(shown, parseThread);
    const last = after?.messages.at(-1);
    if (after === undefined || last === undefined || last.sender !== "user" || !sameText(last.text, text)) return undefined;
    // The same text already ended the conversation: only a longer conversation proves a new message.
    return sameAsBefore && after.messages.length <= now.messages.length ? undefined : true;
  }, timeoutOf(deps));
  if (appeared === undefined) return giveUp(deps, "the message did not appear in the conversation after Send");
  return "sent";
}

/** Not verified on the live site. */
async function clearAnd(deps: WriteDeps, result: MessageResult): Promise<MessageResult> {
  await deps.page.clear(MESSAGE_BOX);
  return result;
}
