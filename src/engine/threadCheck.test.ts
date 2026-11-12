import { describe, expect, it } from "vitest";
import type { Message, Sender } from "../linkedin/parse/thread";
import { judgeSend, judgeThread, sameText, type AppSent, type ThreadVerdict } from "./threadCheck";

function message(sender: Sender, text: string): Message {
  return {
    sender,
    senderName: sender === "user" ? "Alex Bianchi" : "Marco Rossi",
    subject: null,
    text,
    sentAtRaw: "Today 10:02 AM",
    sentAt: null,
  };
}
const user = (text: string) => message("user", text);
const participant = (text: string) => message("participant", text);

const NOTE = "Hi Marco, saw your work at Rossi Srl. Happy to connect.";
const FIRST = "Thanks for connecting, Marco!\n\nQuick question about Rossi Srl.";
const FOLLOW_UP = "Hi Marco, just bumping this up.";

describe("judgeThread", () => {
  const cases: readonly {
    readonly name: string;
    readonly messages: readonly Message[];
    readonly sent: AppSent;
    readonly verdict: ThreadVerdict;
  }[] = [
    { name: "empty thread, nothing sent yet", messages: [], sent: { inviteNote: null, messages: [] }, verdict: { verdict: "clear", userMessages: 0 } },
    { name: "empty thread, note not shown", messages: [], sent: { inviteNote: NOTE, messages: [] }, verdict: { verdict: "clear", userMessages: 0 } },
    { name: "note shown, nothing else sent", messages: [user(NOTE)], sent: { inviteNote: NOTE, messages: [] }, verdict: { verdict: "clear", userMessages: 1 } },
    { name: "only the first message, no note", messages: [user(FIRST)], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "clear", userMessages: 1 } },
    { name: "first message, note not shown", messages: [user(FIRST)], sent: { inviteNote: NOTE, messages: [FIRST] }, verdict: { verdict: "clear", userMessages: 1 } },
    { name: "note shown, then first message", messages: [user(NOTE), user(FIRST)], sent: { inviteNote: NOTE, messages: [FIRST] }, verdict: { verdict: "clear", userMessages: 2 } },
    { name: "note shown, first message and follow-up", messages: [user(NOTE), user(FIRST), user(FOLLOW_UP)], sent: { inviteNote: NOTE, messages: [FIRST, FOLLOW_UP] }, verdict: { verdict: "clear", userMessages: 3 } },
    {
      name: "whitespace, line breaks and non-breaking spaces LinkedIn redrew",
      messages: [user(`  ${NOTE.replace(" saw", " saw")}\n`), user(FIRST.replace("\n\n", "\n \n"))],
      sent: { inviteNote: NOTE, messages: [FIRST] },
      verdict: { verdict: "clear", userMessages: 2 },
    },
    { name: "a reply on an empty send history", messages: [participant("Hello?")], sent: { inviteNote: null, messages: [] }, verdict: { verdict: "replied" } },
    { name: "a reply after the first message", messages: [user(FIRST), participant("Thanks, tell me more")], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "replied" } },
    { name: "a reply before the app's messages", messages: [participant("Hi!"), user(FIRST)], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "replied" } },
    { name: "a reply between the app's messages", messages: [user(FIRST), participant("ok"), user(FOLLOW_UP)], sent: { inviteNote: null, messages: [FIRST, FOLLOW_UP] }, verdict: { verdict: "replied" } },
    { name: "a reply wins over a manual message", messages: [user("Hey, it's me"), participant("Hi")], sent: { inviteNote: null, messages: [] }, verdict: { verdict: "replied" } },
    { name: "an empty reply (an attachment) still counts", messages: [user(FIRST), participant("")], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "replied" } },
    { name: "the user wrote before anything was sent", messages: [user("Hey Marco")], sent: { inviteNote: null, messages: [] }, verdict: { verdict: "manual_takeover" } },
    { name: "the user re-sent the first message by hand", messages: [user(FIRST), user(FIRST)], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "manual_takeover" } },
    { name: "the user re-sent the note by hand", messages: [user(NOTE), user(NOTE), user(FIRST)], sent: { inviteNote: NOTE, messages: [FIRST] }, verdict: { verdict: "manual_takeover" } },
    { name: "an extra message after the app's", messages: [user(FIRST), user("PS: call me")], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "manual_takeover" } },
    { name: "an extra message before the app's", messages: [user("Hey"), user(FIRST)], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "manual_takeover" } },
    { name: "a sent message is missing", messages: [user(FIRST)], sent: { inviteNote: null, messages: [FIRST, FOLLOW_UP] }, verdict: { verdict: "manual_takeover" } },
    { name: "the first message is missing", messages: [], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "manual_takeover" } },
    { name: "a different text", messages: [user(`${FIRST}!`)], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "manual_takeover" } },
    { name: "a case difference is a different text", messages: [user(FIRST.toUpperCase())], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "manual_takeover" } },
    { name: "a different order", messages: [user(FOLLOW_UP), user(FIRST)], sent: { inviteNote: null, messages: [FIRST, FOLLOW_UP] }, verdict: { verdict: "manual_takeover" } },
    { name: "the note after the first message", messages: [user(FIRST), user(NOTE)], sent: { inviteNote: NOTE, messages: [FIRST] }, verdict: { verdict: "manual_takeover" } },
    { name: "a note-like message when no note was sent", messages: [user(NOTE), user(FIRST)], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "manual_takeover" } },
    { name: "an empty user message (an attachment) when no note was sent", messages: [user(""), user(FIRST)], sent: { inviteNote: null, messages: [FIRST] }, verdict: { verdict: "manual_takeover" } },
    { name: "an empty user message when the note was blank", messages: [user(""), user(FIRST)], sent: { inviteNote: "  ", messages: [FIRST] }, verdict: { verdict: "manual_takeover" } },
  ];

  it.each(cases)("$name", ({ messages, sent, verdict }) => {
    expect(judgeThread({ messages }, sent)).toEqual(verdict);
  });
});

describe("judgeSend", () => {
  it("is not_sent when the user's message count did not change", () => {
    expect(judgeSend({ messages: [user(NOTE)] }, FIRST, 1)).toBe("not_sent");
    expect(judgeSend({ messages: [] }, FIRST, 0)).toBe("not_sent");
  });

  it("is sent when there is exactly one more user message and it is the text", () => {
    expect(judgeSend({ messages: [user(NOTE), user(FIRST)] }, FIRST, 1)).toBe("sent");
    expect(judgeSend({ messages: [user(FIRST.replace("\n\n", "\n"))] }, FIRST, 0)).toBe("sent");
  });

  it("looks at the newest user message, not the newest message", () => {
    expect(judgeSend({ messages: [user(FIRST), participant("Thanks!")] }, FIRST, 0)).toBe("sent");
  });

  it("is unclear when the one new user message is another text", () => {
    expect(judgeSend({ messages: [user(NOTE), user("Hey Marco")] }, FIRST, 1)).toBe("unclear");
  });

  it("is unclear when the count jumped by two", () => {
    expect(judgeSend({ messages: [user(FIRST), user(FIRST)] }, FIRST, 0)).toBe("unclear");
  });

  it("is unclear when the count went down", () => {
    expect(judgeSend({ messages: [user(FIRST)] }, FIRST, 2)).toBe("unclear");
  });

  it("counts only the user's messages", () => {
    expect(judgeSend({ messages: [participant("Hi"), participant("Hello?")] }, FIRST, 0)).toBe("not_sent");
  });
});

describe("sameText", () => {
  it.each([
    ["identical", "Hi Marco", "Hi Marco"],
    ["outer whitespace", "  Hi Marco\n", "Hi Marco"],
    ["runs of spaces", "Hi   Marco", "Hi Marco"],
    ["line breaks against spaces", "Hi\nMarco", "Hi Marco"],
    ["CRLF against LF", "Hi,\r\n\r\nMarco", "Hi,\n\nMarco"],
    ["blank lines collapsed", "Hi,\n\n\nMarco", "Hi,\nMarco"],
    ["tabs", "Hi\tMarco", "Hi Marco"],
    ["non-breaking spaces", "Hi Marco", "Hi Marco"],
    ["narrow non-breaking spaces", "Hi Marco", "Hi Marco"],
    ["composed against decomposed accents", "Ciao Nicolò", "Ciao Nicolò"],
  ])("treats %s as the same", (_case, a, b) => {
    expect(sameText(a, b)).toBe(true);
    expect(sameText(b, a)).toBe(true);
  });

  it.each([
    ["case", "Hi Marco", "hi marco"],
    ["punctuation", "Hi Marco!", "Hi Marco"],
    ["a space removed inside a word", "Hi Marco", "HiMarco"],
    ["a different accent", "Ciao Nicolò", "Ciao Nicoló"],
    ["empty against text", "", "Hi"],
  ])("treats %s as different", (_case, a, b) => {
    expect(sameText(a, b)).toBe(false);
  });
});
