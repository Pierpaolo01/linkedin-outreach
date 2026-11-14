/** Tests on saved pages and invented dialogs only: the write operations are NOT VERIFIED ON THE LIVE SITE. */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersonRef } from "../driver";
import { Checkpoint, LimitHit, Unexpected } from "../errors";
import { parseProfile } from "../parse/profile";
import { sendInvite } from "./invite";
import { scriptedPage, type ScriptedControls, type ScriptedEvent } from "./scriptedPage";
import {
  asPending,
  CONNECT_PROFILE,
  fixture,
  FOLLOW_PROFILE,
  italianProfile,
  overlay,
  PROFILE_PERSON,
  PROFILE_URL,
} from "./testPages";

const NOW = new Date("2026-11-12T10:00:00Z");
const GUARD = { notAfter: new Date("2026-11-12T17:00:00Z") };
const NOTE = "TEST NOTE - not a real invitation";

type React = (event: ScriptedEvent, controls: ScriptedControls) => void;
type Hover = NonNullable<Parameters<typeof scriptedPage>[0]["hover"]>;

function run({ profile = fixture(CONNECT_PROFILE), react, hover, url }: { profile?: string; react?: React; hover?: Hover; url?: string } = {}) {
  const controls = scriptedPage({
    now: NOW,
    route: (asked) => ({ url: url ?? asked, html: profile }),
    ...(react === undefined ? {} : { react }),
    ...(hover === undefined ? {} : { hover }),
  });
  const deps = {
    page: controls.page,
    pace: async () => undefined,
    health: { screenshotsDir: mkdtempSync(join(tmpdir(), "write-")) },
    timeoutMs: 5_000,
  };
  return { ...controls, deps };
}

/** The accessible names of what was clicked, in order. */
const clicks = (events: readonly ScriptedEvent[]) => events.flatMap((e) => (e.kind === "click" ? [e.name] : []));
const typed = (events: readonly ScriptedEvent[]) => events.flatMap((e) => (e.kind === "type" ? [e.text] : []));
const acted = (events: readonly ScriptedEvent[]) => events.filter((e) => e.kind === "click" || e.kind === "type");

/**
 * LinkedIn as the tests script it: Connect opens `afterConnect`; the dialog's buttons lead on to
 * the note box and to `afterSend`; Escape closes any dialog. Each dialog is an invented fixture.
 */
function linkedIn({
  profile = fixture(CONNECT_PROFILE),
  lang = "en",
  afterConnect = `synthetic-invite-choose-${lang}.html`,
  afterAddNote = `synthetic-invite-note-${lang}.html`,
  afterSend = asPending(profile),
  menu = `synthetic-more-menu-connect-${lang}.html`,
}: {
  profile?: string;
  lang?: "en" | "it";
  afterConnect?: string | null;
  afterAddNote?: string;
  afterSend?: string;
  menu?: string;
} = {}): React {
  return (event, c) => {
    if (event.kind === "dismiss") c.show(profile);
    if (event.kind !== "click") return;
    const name = event.name.toLowerCase();
    if (name === "more" || name === "altro") c.show(overlay(profile, menu));
    else if (/connect|collegarsi/.test(name)) c.show(afterConnect === null ? profile : overlay(profile, afterConnect));
    else if (/^(add a note|aggiungi una nota)$/.test(name)) c.show(overlay(profile, afterAddNote));
    else if (/^(send|invia|send without a note|invia senza nota)$/.test(name)) c.show(afterSend);
  };
}

describe("sendInvite on a saved profile that offers Connect", () => {
  it("sends without a note: Connect, then Send without a note, then sees Pending", async () => {
    const { deps, events } = run({ react: linkedIn() });

    await expect(sendInvite(deps, PROFILE_PERSON, null, GUARD)).resolves.toBe("sent");
    expect(events[0]).toEqual({ kind: "load", url: PROFILE_URL });
    expect(clicks(events)).toEqual(["Invite Person 1 to connect", "Send without a note"]);
    expect(typed(events)).toEqual([]);
  });

  it("sends with a note: Add a note, types the note, then Send", async () => {
    const { deps, events } = run({ react: linkedIn() });

    await expect(sendInvite(deps, PROFILE_PERSON, NOTE, GUARD)).resolves.toBe("sent");
    expect(clicks(events)).toEqual(["Invite Person 1 to connect", "Add a note", "Send"]);
    expect(typed(events)).toEqual([NOTE]);
  });

  it("treats a blank note as no note", async () => {
    const { deps, events } = run({ react: linkedIn() });

    await expect(sendInvite(deps, PROFILE_PERSON, "  ", GUARD)).resolves.toBe("sent");
    expect(clicks(events)).toEqual(["Invite Person 1 to connect", "Send without a note"]);
  });

  it("works on the Italian interface", async () => {
    const profile = italianProfile(fixture(CONNECT_PROFILE));
    const { deps, events } = run({ profile, react: linkedIn({ profile, lang: "it", afterSend: asPending(profile, "In sospeso", "In sospeso") }) });

    await expect(sendInvite(deps, PROFILE_PERSON, NOTE, GUARD)).resolves.toBe("sent");
    expect(clicks(events)).toEqual(["Invita Person 1 a collegarsi", "Aggiungi una nota", "Invia"]);
    expect(typed(events)).toEqual([NOTE]);
  });

  it("sends without a note on the Italian interface", async () => {
    const profile = italianProfile(fixture(CONNECT_PROFILE));
    const { deps, events } = run({ profile, react: linkedIn({ profile, lang: "it", afterSend: asPending(profile, "In sospeso", "In sospeso") }) });

    await expect(sendInvite(deps, PROFILE_PERSON, null, GUARD)).resolves.toBe("sent");
    expect(clicks(events)).toEqual(["Invita Person 1 a collegarsi", "Invia senza nota"]);
  });
});

describe("sendInvite with Connect under More", () => {
  const profile = fixture(FOLLOW_PROFILE);
  const person = { publicId: "person-1", memberId: parseProfile(profile).memberId ?? "" };

  it("opens More and clicks Connect in the menu", async () => {
    const { deps, events } = run({ profile, react: linkedIn({ profile }) });

    await expect(sendInvite(deps, person, null, GUARD)).resolves.toBe("sent");
    expect(clicks(events)).toEqual(["More", "Invite Person 1 to connect", "Send without a note"]);
  });

  it("is not_offered when the menu holds no Connect, and closes the menu", async () => {
    const { deps, events } = run({ profile, react: linkedIn({ profile, menu: "synthetic-more-menu-no-connect-en.html" }) });

    await expect(sendInvite(deps, person, NOTE, GUARD)).resolves.toBe("not_offered");
    expect(clicks(events)).toEqual(["More"]);
    expect(events.at(-1)).toEqual({ kind: "dismiss" });
  });

  it("reads the Italian menu", async () => {
    const italian = italianProfile(profile);
    const { deps, events } = run({
      profile: italian,
      react: linkedIn({ profile: italian, lang: "it", afterSend: asPending(profile, "In sospeso", "In sospeso").replace('<html lang="en"', '<html lang="it"') }),
    });

    await expect(sendInvite(deps, person, null, GUARD)).resolves.toBe("sent");
    expect(clicks(events)).toEqual(["Altro", "Invita Person 1 a collegarsi", "Invia senza nota"]);
  });
});

describe("sendInvite refusals", () => {
  it("is already_pending on a profile that shows Pending, and clicks nothing", async () => {
    const { deps, events } = run({ profile: asPending(fixture(CONNECT_PROFILE)) });

    await expect(sendInvite(deps, PROFILE_PERSON, NOTE, GUARD)).resolves.toBe("already_pending");
    expect(acted(events)).toEqual([]);
  });

  it("is already_connected on a 1st-degree profile, and clicks nothing", async () => {
    const profile = fixture("profile/connected-later-en.html");
    const person = { publicId: "person-1", memberId: parseProfile(profile).memberId ?? "" };
    const { deps, events } = run({ profile });

    await expect(sendInvite(deps, person, NOTE, GUARD)).resolves.toBe("already_connected");
    expect(acted(events)).toEqual([]);
  });

  it.each(["en", "it"] as const)("is not_offered when LinkedIn asks for the person's email (%s), after closing the dialog", async (lang) => {
    const base = fixture(CONNECT_PROFILE);
    const profile = lang === "it" ? italianProfile(base) : base;
    const { deps, events } = run({ profile, react: linkedIn({ profile, lang, afterConnect: `synthetic-invite-email-${lang}.html` }) });

    await expect(sendInvite(deps, PROFILE_PERSON, NOTE, GUARD)).resolves.toBe("not_offered");
    expect(clicks(events)).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: "dismiss" });
  });

  it.each(["en", "it"] as const)("throws LimitHit on LinkedIn's weekly limit after Connect (%s): nothing was sent", async (lang) => {
    const base = fixture(CONNECT_PROFILE);
    const profile = lang === "it" ? italianProfile(base) : base;
    const { deps, events } = run({ profile, react: linkedIn({ profile, lang, afterConnect: `synthetic-invite-limit-${lang}.html` }) });

    const error = await sendInvite(deps, PROFILE_PERSON, NOTE, GUARD).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LimitHit);
    expect(clicks(events)).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: "dismiss" });
  });

  it("throws LimitHit when the limit message comes after Send", async () => {
    const profile = fixture(CONNECT_PROFILE);
    const { deps } = run({ react: linkedIn({ afterSend: overlay(profile, "synthetic-invite-limit-en.html") }) });

    await expect(sendInvite(deps, PROFILE_PERSON, null, GUARD)).rejects.toThrow(LimitHit);
  });

  it("returns note_quota when no free note is left, sending nothing", async () => {
    const { deps, events } = run({ react: linkedIn({ afterAddNote: "synthetic-invite-note-quota-en.html" }) });

    await expect(sendInvite(deps, PROFILE_PERSON, NOTE, GUARD)).resolves.toBe("note_quota");
    expect(clicks(events)).toEqual(["Invite Person 1 to connect", "Add a note"]);
  });

  it("refuses a note longer than LinkedIn takes before loading anything", async () => {
    const { deps, events } = run();

    await expect(sendInvite(deps, PROFILE_PERSON, "x".repeat(201), GUARD)).rejects.toThrow(Unexpected);
    expect(events).toEqual([]);
  });

  it("refuses when the note box does not hold the note as typed (a shorter limit cut it)", async () => {
    const { deps, events, page } = run({ react: linkedIn() });
    const realType = page.type.bind(page);
    page.type = async (target, text) => realType(target, text.slice(0, 10));

    await expect(sendInvite(deps, PROFILE_PERSON, NOTE, GUARD)).resolves.toBe("note_not_taken");
    expect(clicks(events)).toEqual(["Invite Person 1 to connect", "Add a note"]);
  });
});

describe("sendInvite on the wrong person", () => {
  it.each([
    ["another public id", { publicId: "person-2", memberId: PROFILE_PERSON.memberId }],
    ["another member id", { publicId: "person-1", memberId: "ACoAAsomeoneElse" }],
  ])("clicks nothing when the profile shows %s, saves the page and throws", async (_case, person) => {
    const { deps, events } = run({ react: linkedIn() });

    const error = await sendInvite(deps, person, NOTE, GUARD).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unexpected);
    expect(existsSync((error as Unexpected).artifacts?.html ?? "")).toBe(true);
    expect(acted(events)).toEqual([]);
  });

  it("clicks nothing when the top card's Connect link names someone else", async () => {
    const profile = fixture(CONNECT_PROFILE).replaceAll("vanityName=person-1", "vanityName=person-9");
    const { deps, events } = run({ profile, react: linkedIn({ profile }) });

    await expect(sendInvite(deps, PROFILE_PERSON, NOTE, GUARD)).rejects.toThrow(Unexpected);
    expect(acted(events)).toEqual([]);
  });
});

describe("sendInvite and the deadline", () => {
  it("does nothing at all when the deadline has passed", async () => {
    const { deps, events } = run();

    await expect(sendInvite(deps, PROFILE_PERSON, NOTE, { notAfter: new Date(NOW.getTime() - 1) })).resolves.toBe("expired");
    expect(events).toEqual([]);
  });

  /** Passes the deadline right after the n-th action and returns what happened after it. */
  async function expireAfter(n: number, { profile, note, person }: { profile: string; note: string | null; person: PersonRef }) {
    const script = linkedIn({ profile });
    let seen = 0;
    const { deps, events } = run({
      profile,
      react: (event, c) => {
        script(event, c);
        seen += 1;
        if (seen === n) c.advance(GUARD.notAfter.getTime() - NOW.getTime() + 1);
      },
    });
    const result = await sendInvite(deps, person, note, GUARD);
    return { result, after: events.slice(n) };
  }

  // Steps: load, then each click or typing. The deadline is read before each.
  it.each([
    ["Connect", 1, NOTE],
    ["Add a note", 2, NOTE],
    ["typing the note", 3, NOTE],
    ["Send", 4, NOTE],
    ["Send without a note", 2, null],
  ] as const)("is checked before %s", async (_step, n, note) => {
    const { result, after } = await expireAfter(n, { profile: fixture(CONNECT_PROFILE), note, person: PROFILE_PERSON });

    expect(result).toBe("expired");
    expect(acted(after)).toEqual([]);
  });

  // The clicks that act on LinkedIn: the deadline is read again after the hover and pause, immediately before the click itself.
  it.each([
    ["Connect", /to connect$/, NOTE],
    ["Send", /^Send$/, NOTE],
    ["Send without a note", /^Send without a note$/, null],
  ] as const)("is read again after the hover before %s, and nothing is clicked past it", async (_step, hovered, note) => {
    const { deps, events } = run({
      react: linkedIn(),
      hover: ({ name }, c) => {
        if (hovered.test(name)) c.advance(GUARD.notAfter.getTime() - NOW.getTime() + 1);
      },
    });

    await expect(sendInvite(deps, PROFILE_PERSON, note, GUARD)).resolves.toBe("expired");
    expect(clicks(events).filter((name) => hovered.test(name))).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: "dismiss" });
  });

  it("is checked before opening More and before Connect in the menu", async () => {
    const profile = fixture(FOLLOW_PROFILE);
    const person = { publicId: "person-1", memberId: parseProfile(profile).memberId ?? "" };
    for (const n of [1, 2]) {
      const { result, after } = await expireAfter(n, { profile, note: null, person });
      expect(result).toBe("expired");
      expect(acted(after)).toEqual([]);
    }
  });
});

describe("sendInvite on pages it does not recognise", () => {
  async function expectSavedUnexpected(promise: Promise<unknown>) {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unexpected);
    expect(existsSync((error as Unexpected).artifacts?.html ?? "")).toBe(true);
  }

  it("throws on a page that is not a profile", async () => {
    const { deps, events } = run({ profile: fixture("session/synthetic-feed-signed-in.html") });

    await expectSavedUnexpected(sendInvite(deps, PROFILE_PERSON, NOTE, GUARD));
    expect(acted(events)).toEqual([]);
  });

  it("throws when nothing appears after Connect", async () => {
    const { deps } = run({ react: linkedIn({ afterConnect: null }) });

    await expectSavedUnexpected(sendInvite(deps, PROFILE_PERSON, NOTE, GUARD));
  });

  it("throws on a dialog it does not know", async () => {
    const { deps } = run({ react: linkedIn({ afterConnect: "synthetic-withdraw-confirm-en.html" }) });

    await expectSavedUnexpected(sendInvite(deps, PROFILE_PERSON, NOTE, GUARD));
  });

  it("throws when the profile does not show Pending after Send (the result is not known)", async () => {
    const { deps } = run({ react: linkedIn({ afterSend: fixture(CONNECT_PROFILE) }) });

    await expectSavedUnexpected(sendInvite(deps, PROFILE_PERSON, null, GUARD));
  });

  it("throws when the More menu does not open", async () => {
    const profile = fixture(FOLLOW_PROFILE);
    const person = { publicId: "person-1", memberId: parseProfile(profile).memberId ?? "" };
    const { deps } = run({ profile });

    await expectSavedUnexpected(sendInvite(deps, person, null, GUARD));
  });

  it("throws the checkpoint, not Unexpected, when a checkpoint is shown, and clicks nothing", async () => {
    const { deps, events } = run({
      profile: fixture("session/synthetic-checkpoint-challenge-en.html"),
      url: "https://www.linkedin.com/checkpoint/challenge/x",
    });

    await expect(sendInvite(deps, PROFILE_PERSON, NOTE, GUARD)).rejects.toThrow(Checkpoint);
    expect(acted(events)).toEqual([]);
  });
});
