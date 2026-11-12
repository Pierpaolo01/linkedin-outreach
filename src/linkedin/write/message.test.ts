/** Tests on saved pages and invented dialogs only: the write operations are NOT VERIFIED ON THE LIVE SITE. */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoggedOut, Unexpected } from "../errors";
import { sendMessage } from "./message";
import { keystrokesFor } from "./page";
import { scriptedPage, type ScriptedControls, type ScriptedEvent } from "./scriptedPage";
import { COMPOSE_EXISTING, COMPOSE_PERSON, composeUrl, fixture, withDraft, withMessage, withMessageForm } from "./testPages";

const NOW = new Date("2026-11-12T10:00:00Z");
const NOT_AFTER = new Date("2026-11-12T17:00:00Z");
const TEXT = "TEST MESSAGE line one\nTEST MESSAGE line two";
/** The saved conversation shows six messages. */
const SHOWN = 6;
const EXPECTED = { notAfter: NOT_AFTER, messageCount: SHOWN };

type React = (event: ScriptedEvent, controls: ScriptedControls) => void;

function run({ html = fixture(COMPOSE_EXISTING), react, landOn }: { html?: string; react?: React; landOn?: string } = {}) {
  const controls = scriptedPage({
    now: NOW,
    route: (url) => ({ url: landOn ?? url, html }),
    ...(react === undefined ? {} : { react }),
  });
  const deps = {
    page: controls.page,
    pace: async () => undefined,
    health: { screenshotsDir: mkdtempSync(join(tmpdir(), "write-")) },
    timeoutMs: 5_000,
  };
  return { ...controls, deps };
}

/** LinkedIn as the tests script it: Send adds the typed text to the conversation as the user's message. */
function linkedIn(html: string): React {
  return (event, c) => {
    if (event.kind === "click" && /^(send|invia)$/i.test(event.name)) {
      const box = { roles: ["textbox"], within: { css: ".msg-convo-wrapper .msg-form" } } as const;
      c.show(withMessage(html, "user", c.typed(box) ?? ""));
    }
  };
}

const kinds = (events: readonly ScriptedEvent[]) => events.map((e) => (e.kind === "click" ? `click ${e.name}` : e.kind));

describe("sendMessage on a saved conversation", () => {
  it("opens the conversation by its compose URL, types the text and clicks Send", async () => {
    const html = fixture(COMPOSE_EXISTING);
    const { deps, events } = run({ html, react: linkedIn(html) });

    await expect(sendMessage(deps, COMPOSE_PERSON, TEXT, EXPECTED)).resolves.toBe("sent");
    expect(events[0]).toEqual({ kind: "load", url: composeUrl(COMPOSE_PERSON.memberId) });
    expect(kinds(events)).toEqual(["load", "type", "click Send"]);
    expect(events.flatMap((e) => (e.kind === "type" ? [e.text] : []))).toEqual([TEXT]);
  });

  it("clears a draft left in the message box before typing", async () => {
    const html = withDraft(fixture(COMPOSE_EXISTING), "an old draft");
    const { deps, events, typed } = run({ html, react: linkedIn(html) });

    await expect(sendMessage(deps, COMPOSE_PERSON, TEXT, EXPECTED)).resolves.toBe("sent");
    expect(kinds(events)).toEqual(["load", "clear", "type", "click Send"]);
    expect(typed({ roles: ["textbox"], within: { css: ".msg-convo-wrapper .msg-form" } })).toBe(TEXT);
  });

  it("works on the Italian interface", async () => {
    const html = withMessageForm(fixture("messaging/synthetic-user-only-it.html"));
    const person = { publicId: "elena-inventata", memberId: "ACoAAPARTICIPANT0000000000000000000000003" };
    const { deps, events } = run({ html, react: linkedIn(html) });

    await expect(sendMessage(deps, person, "TEST MESSAGGIO", { notAfter: NOT_AFTER, messageCount: 1 })).resolves.toBe("sent");
    expect(kinds(events)).toEqual(["load", "type", "click Invia"]);
  });
});

describe("sendMessage and the message count", () => {
  it("is thread_changed, typing nothing, when the conversation does not show the count the caller judged", async () => {
    const { deps, events } = run();

    await expect(sendMessage(deps, COMPOSE_PERSON, TEXT, { notAfter: NOT_AFTER, messageCount: SHOWN - 1 })).resolves.toBe("thread_changed");
    expect(kinds(events)).toEqual(["load"]);
  });

  it("compares again right before Send: a reply that arrived while typing stops it and the draft is cleared", async () => {
    const html = fixture(COMPOSE_EXISTING);
    const { deps, events } = run({
      html,
      react: (event, c) => {
        if (event.kind === "type") c.show(withMessage(html, "participant", "TEST REPLY"));
      },
    });

    await expect(sendMessage(deps, COMPOSE_PERSON, TEXT, EXPECTED)).resolves.toBe("thread_changed");
    expect(kinds(events)).toEqual(["load", "type", "clear"]);
  });
});

describe("sendMessage and the deadline", () => {
  it("does nothing at all when the deadline has passed", async () => {
    const { deps, events } = run();

    await expect(sendMessage(deps, COMPOSE_PERSON, TEXT, { notAfter: new Date(NOW.getTime() - 1), messageCount: SHOWN })).resolves.toBe("expired");
    expect(events).toEqual([]);
  });

  /** Passes the deadline right after the action of the given kind. */
  function expiringAfter(kind: ScriptedEvent["kind"]): React {
    return (event, c) => {
      if (event.kind === kind) c.advance(NOT_AFTER.getTime() - NOW.getTime() + 1);
    };
  }

  it("is checked before typing", async () => {
    const { deps, events } = run({ react: expiringAfter("load") });

    await expect(sendMessage(deps, COMPOSE_PERSON, TEXT, EXPECTED)).resolves.toBe("expired");
    expect(kinds(events)).toEqual(["load"]);
  });

  it("is checked right before Send: past it, the typed text is cleared and nothing is sent", async () => {
    const { deps, events } = run({ react: expiringAfter("type") });

    await expect(sendMessage(deps, COMPOSE_PERSON, TEXT, EXPECTED)).resolves.toBe("expired");
    expect(kinds(events)).toEqual(["load", "type", "clear"]);
  });
});

describe("sendMessage refusals", () => {
  async function expectSavedUnexpected(promise: Promise<unknown>) {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unexpected);
    expect(existsSync((error as Unexpected).artifacts?.html ?? "")).toBe(true);
  }

  it("types and clicks nothing when the conversation is with someone else", async () => {
    const { deps, events } = run();

    await expectSavedUnexpected(sendMessage(deps, { publicId: "x", memberId: "ACoAAsomeoneElse" }, TEXT, EXPECTED));
    expect(kinds(events)).toEqual(["load"]);
  });

  it("types and clicks nothing when LinkedIn opened another conversation than the compose URL asked for", async () => {
    const html = fixture("messaging/synthetic-new-message-en.html");
    const { deps, events } = run({ html, landOn: "https://www.linkedin.com/messaging/thread/2-other/" });

    await expectSavedUnexpected(sendMessage(deps, { publicId: "gina-prova", memberId: "ACoAAgina" }, TEXT, { notAfter: NOT_AFTER, messageCount: 0 }));
    expect(kinds(events)).toEqual(["load"]);
  });

  it("throws on a page that is not a conversation", async () => {
    const { deps, events } = run({ html: fixture("session/synthetic-feed-signed-in.html") });

    await expectSavedUnexpected(sendMessage(deps, COMPOSE_PERSON, TEXT, EXPECTED));
    expect(kinds(events)).toEqual(["load"]);
  });

  it("throws when the conversation has no message box", async () => {
    const html = fixture("messaging/synthetic-user-only-it.html");
    const person = { publicId: "elena-inventata", memberId: "ACoAAPARTICIPANT0000000000000000000000003" };
    const { deps, events } = run({ html });

    await expectSavedUnexpected(sendMessage(deps, person, TEXT, { notAfter: NOT_AFTER, messageCount: 1 }));
    expect(kinds(events)).toEqual(["load"]);
  });

  it("clears and throws, sending nothing, when the box does not hold the text as typed", async () => {
    const { deps, events, page } = run();
    const realType = page.type.bind(page);
    page.type = async (target) => realType(target, "TEST something else");

    await expectSavedUnexpected(sendMessage(deps, COMPOSE_PERSON, TEXT, EXPECTED));
    expect(kinds(events)).toEqual(["load", "type", "clear"]);
  });

  it("throws when the message does not appear after Send (the result is not known)", async () => {
    const { deps, events } = run();

    await expectSavedUnexpected(sendMessage(deps, COMPOSE_PERSON, TEXT, EXPECTED));
    expect(kinds(events)).toEqual(["load", "type", "click Send", "timeout"]);
  });

  it("does not take another text at the end of the conversation for the one sent", async () => {
    const html = fixture(COMPOSE_EXISTING);
    const { deps } = run({
      html,
      react: (event, c) => {
        if (event.kind === "click") c.show(withMessage(html, "user", "TEST a different text"));
      },
    });

    await expectSavedUnexpected(sendMessage(deps, COMPOSE_PERSON, TEXT, EXPECTED));
  });

  it("throws the login wall, not Unexpected, and types nothing", async () => {
    const { deps, events } = run({ html: "<html></html>", landOn: "https://www.linkedin.com/authwall?trk=x" });

    await expect(sendMessage(deps, COMPOSE_PERSON, TEXT, EXPECTED)).rejects.toThrow(LoggedOut);
    expect(kinds(events)).toEqual(["load"]);
  });
});

describe("keystrokesFor", () => {
  it("types a line break as Shift+Enter, never Enter", () => {
    expect(keystrokesFor("TEST one\nTEST two\r\n\nTEST three")).toEqual([
      { kind: "text", text: "TEST one" },
      { kind: "line_break" },
      { kind: "text", text: "TEST two" },
      { kind: "line_break" },
      { kind: "line_break" },
      { kind: "text", text: "TEST three" },
    ]);
  });
});
