import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ParseError } from "./card";
import { findThreadUrl, parseConversationList, parseThread } from "./thread";

const fixture = (name: string) => readFileSync(join(process.cwd(), "fixtures/messaging", name), "utf8");

/** Replaces every occurrence and fails loudly if there is none, so a stale edit cannot pass vacuously. */
function mutate(html: string, from: string | RegExp, to: string): string {
  const next = typeof from === "string" ? html.replaceAll(from, to) : html.replace(from, to);
  if (next === html) throw new Error(`fixture edit did not apply: ${String(from)}`);
  return next;
}

describe("parseThread", () => {
  it("attributes each message of a two-way conversation to the user or the participant", () => {
    const thread = parseThread(fixture("synthetic-two-way-en.html"));

    expect(thread.messages.map((m) => m.sender)).toEqual(["user", "participant", "user"]);
    expect(thread.messages.map((m) => m.senderName)).toEqual(["Ada Example", "Bruno Sample", "Ada Example"]);
    expect(thread.messages.map((m) => m.text)).toEqual([
      "Hi Bruno,\n\nThanks for connecting.",
      "Happy to chat & compare notes.",
      "Thanks, talk soon then",
    ]);
  });

  it("reads the participant from the title bar and calls a plain conversation a message", () => {
    const thread = parseThread(fixture("synthetic-two-way-en.html"));

    expect(thread.participant).toEqual({
      fullName: "Bruno Sample",
      headline: "Head of Example Things",
      publicId: "ACoAAPARTICIPANT0000000000000000000000001",
      profileUrl: "https://www.linkedin.com/in/ACoAAPARTICIPANT0000000000000000000000001/",
    });
    expect(thread.kind).toBe("message");
  });

  it("keeps the day heading with each time and resolves only absolute dates", () => {
    const [first, second, third] = parseThread(fixture("synthetic-two-way-en.html")).messages;

    expect(first?.sentAtRaw).toBe("Mar 3, 2025 10:02 AM");
    expect(first?.sentAt).toEqual(new Date(2025, 2, 3, 10, 2));
    expect(second?.sentAtRaw).toBe("Today 9:40 AM");
    expect(second?.sentAt).toBeNull();
    // No heading of its own: still under "Today".
    expect(third?.sentAtRaw).toBe("Today 10:15 AM");
    expect(third?.sentAt).toBeNull();
  });

  it("gives each message of a group the sender and time of the group's first message", () => {
    const { messages } = parseThread(fixture("synthetic-grouped-en.html"));

    expect(messages.map((m) => [m.sender, m.senderName, m.sentAtRaw])).toEqual([
      ["participant", "Dario Fittizio", "Nov 10 4:05 PM"],
      ["participant", "Dario Fittizio", "Nov 10 4:05 PM"],
      ["user", "Ada Example", "Nov 10 4:20 PM"],
      ["user", "Ada Example", "Nov 10 4:20 PM"],
    ]);
    // "Nov 10" has no year.
    expect(messages.every((m) => m.sentAt === null)).toBe(true);
  });

  it("reads an Italian conversation where only the user has written", () => {
    const thread = parseThread(fixture("synthetic-user-only-it.html"));

    expect(thread.participant.fullName).toBe("Elena Inventata");
    expect(thread.messages).toEqual([
      {
        sender: "user",
        senderName: "Ada Example",
        subject: null,
        text: "Ciao Elena, grazie del collegamento",
        sentAtRaw: "3 mar 2025 14:07",
        sentAt: new Date(2025, 2, 3, 14, 7),
      },
    ]);
  });

  it("returns no messages for an open conversation nobody has written in", () => {
    const thread = parseThread(fixture("synthetic-empty-en.html"));

    expect(thread.participant.fullName).toBe("Gina Prova");
    expect(thread.messages).toEqual([]);
    expect(thread.kind).toBe("unknown");
  });
});

describe("the real messaging page (scrubbed capture, English)", () => {
  // Saved 2026-11-11 from the user's inbox: the newest conversation, an InMail with one incoming message, is open.
  const html = fixture("inbox-inmail-en.html");

  it("reads the open InMail and attributes its one message to the participant", () => {
    const thread = parseThread(html);

    expect(thread.kind).toBe("inmail");
    expect(thread.participant).toMatchObject({
      fullName: "Person 1",
      publicId: "person-1",
      profileUrl: "https://www.linkedin.com/in/person-1/",
    });
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({ sender: "participant", senderName: "Person 1", sentAtRaw: "Today 1:29 PM", sentAt: null });
    expect(thread.messages[0]?.subject).not.toBeNull();
    expect(thread.messages[0]?.text.length).toBeGreaterThan(500);
  });

  it("reads the ten rendered conversation cards and skips the unrendered rows", () => {
    const list = parseConversationList(html);

    expect(list).toHaveLength(10);
    expect(list.map((c) => c.kind)).toEqual([
      "inmail", "message", "inmail", "inmail", "message", "inmail", "message", "inmail", "message", "inmail",
    ]);
    expect(list.map((c) => c.unread)).toEqual([false, false, false, false, false, true, false, false, false, false]);
    expect(list.map((c) => c.snippetSender)).toEqual([null, null, null, null, "participant", null, null, null, null, null]);
    expect(list[0]).toMatchObject({ participantName: "Person 1", timeRaw: "1:29 PM", threadUrl: null });
    // The InMail pill is not part of the snippet.
    expect(list[0]?.snippet.startsWith("InMail")).toBe(false);
  });

  it("holds no thread URL for the open conversation", () => {
    expect(findThreadUrl(html)).toBeNull();
  });
});

describe("parseThread refuses to guess", () => {
  const twoWay = fixture("synthetic-two-way-en.html");
  const USER_ID = "ACoAAUSER00000000000000000000000000000001";
  const PARTICIPANT_ID = "ACoAAPARTICIPANT0000000000000000000000001";

  it("rejects a page that is not the messaging page", () => {
    const feed = '<html lang="en"><body><header id="global-nav"></header><main class="scaffold-layout__main">Feed</main></body></html>';
    expect(() => parseThread(feed)).toThrow(ParseError);
  });

  it("rejects the messaging page when no conversation is open", () => {
    const listOnly = mutate(twoWay, /<div class="msg-convo-wrapper[\s\S]*<\/main>/, "</main>");
    expect(() => parseThread(listOnly)).toThrow(/no conversation is open/);
  });

  it("rejects a message whose sender matches neither the user nor the participant by any signal", () => {
    // The user cannot be identified at all, and the first message names a stranger with no profile link.
    let html = mutate(twoWay, 'alt="Ada Example" class="global-nav__me-photo', 'class="global-nav__me-photo');
    html = mutate(html, `fsd_profile:${USER_ID}`, "fsd_profile:unknown");
    html = mutate(html, `https://www.linkedin.com/in/${USER_ID}`, "#");
    html = mutate(html, ">Ada Example</span></a></span>", ">Someone Else</span></a></span>");
    expect(() => parseThread(html)).toThrow(/cannot tell who sent message 1/);
  });

  it("rejects a message sent by a third person", () => {
    // Every user link becomes a third person's; the user is still known from the message URNs.
    const html = mutate(twoWay, `https://www.linkedin.com/in/${USER_ID}`, "https://www.linkedin.com/in/ACoAATHIRD");
    expect(() => parseThread(html)).toThrow(/neither the user nor the participant/);
  });

  it("rejects a message whose name and profile link point at different people", () => {
    const html = mutate(
      twoWay,
      `<a class="inline-block v-align-middle" href="https://www.linkedin.com/in/${PARTICIPANT_ID}"><span class="msg-s-message-group__profile-link msg-s-message-group__name hoverable-link-text t-14 t-black t-bold">Bruno Sample`,
      `<a class="inline-block v-align-middle" href="https://www.linkedin.com/in/${PARTICIPANT_ID}"><span class="msg-s-message-group__profile-link msg-s-message-group__name hoverable-link-text t-14 t-black t-bold">Ada Example`,
    );
    expect(() => parseThread(html)).toThrow(/contradicts itself on who sent message 2/);
  });

  it("rejects a message the page marks as not the user's when everything else says it is", () => {
    const html = mutate(
      twoWay,
      /class="msg-s-event-listitem msg-s-event-listitem--last-in-group" data-event-urn/,
      'class="msg-s-event-listitem msg-s-event-listitem--last-in-group msg-s-event-listitem--other" data-event-urn',
    );
    expect(() => parseThread(html)).toThrow(/contradicts itself on who sent message 1/);
  });

  it("rejects a first message that has neither name nor avatar", () => {
    const grouped = fixture("synthetic-grouped-en.html");
    const headless = mutate(grouped, /<a tabindex="0"[\s\S]*?<\/time>\s*<\/div>/, "");
    expect(() => parseThread(headless)).toThrow(/first message has no sender/);
  });
});

describe("parseConversationList", () => {
  it("reads each conversation card, its thread link and who the snippet says wrote last", () => {
    expect(parseConversationList(fixture("synthetic-two-way-en.html"))).toEqual([
      {
        participantName: "Bruno Sample",
        snippet: "You: Thanks, talk soon then",
        timeRaw: "10:15 AM",
        unread: false,
        kind: "message",
        snippetSender: "user",
        threadUrl: "https://www.linkedin.com/messaging/thread/2-c3ludGhldGljLXR3by13YXlfMTAw/",
      },
      {
        participantName: "Carla Placeholder",
        snippet: "Carla: Are you free next week?",
        timeRaw: "Mar 1",
        unread: true,
        kind: "message",
        snippetSender: "participant",
        threadUrl: "https://www.linkedin.com/messaging/thread/2-c3ludGhldGljLW90aGVyXzEwMA==/",
      },
    ]);
  });

  it("recognises the Italian 'Tu:' prefix and the InMail pill", () => {
    const [first, second] = parseConversationList(fixture("synthetic-user-only-it.html"));

    expect(first).toMatchObject({ participantName: "Elena Inventata", snippetSender: "user", kind: "message" });
    expect(second).toMatchObject({
      participantName: "Franco Esempio",
      snippet: "Opportunità a Milano",
      kind: "inmail",
      snippetSender: null,
      threadUrl: null,
    });
  });

  it("takes the participant's full name as a snippet prefix too", () => {
    const html = mutate(fixture("synthetic-two-way-en.html"), "Carla: Are you free", "Carla Placeholder: Are you free");
    expect(parseConversationList(html)[1]?.snippetSender).toBe("participant");
  });

  it("returns an empty list for an empty inbox and rejects other pages", () => {
    expect(parseConversationList(fixture("synthetic-empty-en.html"))).toEqual([]);
    expect(() => parseConversationList('<html lang="en"><body><header id="global-nav"></header></body></html>')).toThrow(ParseError);
  });
});

describe("findThreadUrl", () => {
  const grouped = fixture("synthetic-grouped-en.html");

  it("takes the open conversation's link from the active list card, not from the other cards", () => {
    expect(findThreadUrl(fixture("synthetic-two-way-en.html"))).toBe(
      "https://www.linkedin.com/messaging/thread/2-c3ludGhldGljLXR3by13YXlfMTAw/",
    );
  });

  it("returns null when the markup does not hold the open conversation's URL", () => {
    expect(findThreadUrl(grouped)).toBeNull();
  });

  it("reads a canonical link or a conversation URN in the conversation pane", () => {
    const canonical = mutate(grouped, "<head>", '<head><link rel="canonical" href="https://www.linkedin.com/messaging/thread/2-Y2Fub24=/">');
    expect(findThreadUrl(canonical)).toBe("https://www.linkedin.com/messaging/thread/2-Y2Fub24=/");

    const urn = mutate(
      grouped,
      '<div class="msg-title-bar global-title-container shared-title-bar">',
      '<div class="msg-title-bar global-title-container shared-title-bar" data-conversation-urn="urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAUSER,2-dXJu)">',
    );
    expect(findThreadUrl(urn)).toBe("https://www.linkedin.com/messaging/thread/2-dXJu/");
  });
});
