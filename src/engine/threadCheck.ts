/**
 * The thread checks around a message send (spec section 5, decisions 28 and 29). Both fail closed:
 * anything they cannot match exactly stops the sequence or holds the prospect for review.
 */
import type { Message, Thread } from "../linkedin/parse/thread";

/** Texts the app itself sent to this prospect so far. */
export interface AppSent {
  /** The invite note, or null when the invite had none. LinkedIn may or may not show it in the conversation. */
  readonly inviteNote: string | null;
  /** First message, then follow-up, as sent so far, in order. */
  readonly messages: readonly string[];
}
export type ThreadVerdict =
  | { readonly verdict: "clear"; /** How many of the user's messages the thread holds now. */ readonly userMessages: number }
  | { readonly verdict: "replied" }
  | { readonly verdict: "manual_takeover" };

export type SendVerdict = "sent" | "not_sent" | "unclear";

/** True when LinkedIn would show `a` and `b` as the same message. */
export function sameText(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}

function normalise(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function userTexts(messages: readonly Message[]): string[] {
  return messages.filter((message) => message.sender === "user").map((message) => message.text);
}

function sameTexts(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((text, index) => sameText(text, expected[index] ?? ""));
}

/** Decides, before a send, whether the sequence may continue. */
export function judgeThread(thread: Pick<Thread, "messages">, sent: AppSent): ThreadVerdict {
  if (thread.messages.some((message) => message.sender === "participant")) return { verdict: "replied" };

  const texts = userTexts(thread.messages);
  // A blank note is no note: LinkedIn shows none, and an empty user message (an attachment) must not match it.
  const note = sent.inviteNote === null || sent.inviteNote.trim() === "" ? null : sent.inviteNote;
  const matches = sameTexts(texts, sent.messages) || (note !== null && sameTexts(texts, [note, ...sent.messages]));
  return matches ? { verdict: "clear", userMessages: texts.length } : { verdict: "manual_takeover" };
}

/** Decides, after a send whose result is unknown, whether the message went out. */
export function judgeSend(thread: Pick<Thread, "messages">, expectedText: string, userMessagesBefore: number): SendVerdict {
  const texts = userTexts(thread.messages);
  if (texts.length === userMessagesBefore) return "not_sent";
  // The first message of the user that was not there before the send. If it is the text, the text
  // reached the person and is never sent again, whatever the user wrote by hand after it: the
  // next thread check sees those extra messages and stops the sequence as a manual takeover.
  const firstNew = texts.length > userMessagesBefore ? texts[userMessagesBefore] : undefined;
  if (firstNew !== undefined && sameText(firstNew, expectedText)) return "sent";
  return "unclear";
}
