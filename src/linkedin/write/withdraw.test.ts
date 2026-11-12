/** Tests on saved pages and invented dialogs only: the write operations are NOT VERIFIED ON THE LIVE SITE. */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Restricted, Unexpected } from "../errors";
import { scriptedPage, type ScriptedControls, type ScriptedEvent } from "./scriptedPage";
import { fixture, italianSentPage, overlay, SENT_PAGE, SENT_URL, withoutRow } from "./testPages";
import { withdrawInvite } from "./withdraw";

const NOW = new Date("2026-11-12T10:00:00Z");
const GUARD = { notAfter: new Date("2026-11-12T17:00:00Z") };
const PERSON = { publicId: "person-1", memberId: "ACoA00000000000000000000000000000000001" };

type React = (event: ScriptedEvent, controls: ScriptedControls) => void;

function run({ html = fixture(SENT_PAGE), react, landOn }: { html?: string; react?: React; landOn?: string } = {}) {
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

/** LinkedIn as the tests script it: Withdraw asks to confirm; confirming removes the row; Escape closes the dialog. */
function linkedIn(html: string, { lang = "en", confirm = true }: { lang?: "en" | "it"; confirm?: boolean } = {}): React {
  return (event, c) => {
    if (event.kind === "dismiss") c.show(html);
    if (event.kind !== "click") return;
    if (/^(withdraw invitation sent to|ritira invito inviato a)/i.test(event.name)) {
      c.show(confirm ? overlay(html, `synthetic-withdraw-confirm-${lang}.html`) : html);
    } else if (/^(withdraw|ritira)$/i.test(event.name)) {
      c.show(withoutRow(html, "person-1"));
    }
  };
}

const kinds = (events: readonly ScriptedEvent[]) => events.map((e) => (e.kind === "click" ? `click ${e.name}` : e.kind));

describe("withdrawInvite from the saved sent-invitations page", () => {
  it("clicks Withdraw on the person's row, confirms, and sees the row gone", async () => {
    const html = fixture(SENT_PAGE);
    const { deps, events } = run({ html, react: linkedIn(html) });

    await expect(withdrawInvite(deps, PERSON, GUARD)).resolves.toBe("withdrawn");
    expect(events[0]).toEqual({ kind: "load", url: SENT_URL });
    expect(kinds(events)).toEqual(["load", "click Withdraw invitation sent to Person 1", "click Withdraw"]);
  });

  it("works on the Italian interface", async () => {
    const html = italianSentPage(fixture(SENT_PAGE));
    const { deps, events } = run({ html, react: linkedIn(html, { lang: "it" }) });

    await expect(withdrawInvite(deps, PERSON, GUARD)).resolves.toBe("withdrawn");
    expect(kinds(events)).toEqual(["load", "click Ritira invito inviato a Person 1", "click Ritira"]);
  });

  it("is not_pending, clicking nothing, when the list has no invitation to the person", async () => {
    const { deps, events } = run();

    await expect(withdrawInvite(deps, { publicId: "person-9", memberId: "ACoAAnine" }, GUARD)).resolves.toBe("not_pending");
    expect(kinds(events)).toEqual(["load"]);
  });

  it("is not confused by a public id that only starts the same", async () => {
    const { deps, events } = run();

    await expect(withdrawInvite(deps, { publicId: "person", memberId: "ACoAAx" }, GUARD)).resolves.toBe("not_pending");
    expect(kinds(events)).toEqual(["load"]);
  });
});

describe("withdrawInvite and the deadline", () => {
  it("does nothing at all when the deadline has passed", async () => {
    const { deps, events } = run();

    await expect(withdrawInvite(deps, PERSON, { notAfter: new Date(NOW.getTime() - 1) })).resolves.toBe("expired");
    expect(events).toEqual([]);
  });

  it.each([
    ["Withdraw", 1],
    ["the confirmation", 2],
  ])("is checked before %s", async (_step, n) => {
    const html = fixture(SENT_PAGE);
    const script = linkedIn(html);
    let seen = 0;
    const { deps, events } = run({
      html,
      react: (event, c) => {
        script(event, c);
        seen += 1;
        if (seen === n) c.advance(GUARD.notAfter.getTime() - NOW.getTime() + 1);
      },
    });

    await expect(withdrawInvite(deps, PERSON, GUARD)).resolves.toBe("expired");
    expect(events.slice(n).filter((e) => e.kind === "click")).toEqual([]);
  });
});

describe("withdrawInvite on pages it does not recognise", () => {
  async function expectSavedUnexpected(promise: Promise<unknown>) {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unexpected);
    expect(existsSync((error as Unexpected).artifacts?.html ?? "")).toBe(true);
  }

  it("throws on a page that is not the sent-invitations list", async () => {
    const { deps, events } = run({ html: fixture("session/synthetic-feed-signed-in.html") });

    await expectSavedUnexpected(withdrawInvite(deps, PERSON, GUARD));
    expect(kinds(events)).toEqual(["load"]);
  });

  it("throws, clicking nothing, when the person's row has no Withdraw control", async () => {
    const html = fixture(SENT_PAGE)
      .replace(/<a [^>]*aria-label="Withdraw invitation sent to Person 1"[^>]*>[\s\S]*?<\/a>/, "");
    const { deps, events } = run({ html });

    await expectSavedUnexpected(withdrawInvite(deps, PERSON, GUARD));
    expect(kinds(events)).toEqual(["load"]);
  });

  it("throws when no confirmation appears", async () => {
    const html = fixture(SENT_PAGE);
    const { deps, events } = run({ html, react: linkedIn(html, { confirm: false }) });

    await expectSavedUnexpected(withdrawInvite(deps, PERSON, GUARD));
    expect(kinds(events)).toEqual(["load", "click Withdraw invitation sent to Person 1", "timeout"]);
  });

  it("throws when the row is still there after confirming (the result is not known)", async () => {
    const html = fixture(SENT_PAGE);
    const script = linkedIn(html);
    const { deps } = run({
      html,
      react: (event, c) => {
        if (event.kind === "click" && event.name === "Withdraw") c.show(html);
        else script(event, c);
      },
    });

    await expectSavedUnexpected(withdrawInvite(deps, PERSON, GUARD));
  });

  it("throws the restriction, not Unexpected, and clicks nothing", async () => {
    const { deps, events } = run({ html: fixture("session/synthetic-restricted-en.html") });

    await expect(withdrawInvite(deps, PERSON, GUARD)).rejects.toThrow(Restricted);
    expect(kinds(events)).toEqual(["load"]);
  });
});
