import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ParseError } from "./card";
import { parseSentInvitations } from "./sentInvitations";

const SCREEN = "com.linkedin.sdui.flagshipnav.mynetwork.invitations.InvitationSentWithType";

interface RowSpec {
  readonly id?: string;
  readonly name?: string;
  readonly headline?: string | null;
  readonly sent?: string | null;
  readonly withdraw?: boolean;
}

function row({ id = "person-1", name = "Person 1", headline = "Engineer at Company 1", sent = "Sent 4 months ago", withdraw = true }: RowSpec = {}) {
  const line = (text: string) => `<div><p><span>${text}</span></p></div>`;
  return `<hr role="presentation"><div role="listitem" componentkey="auto-component-1"><div>
    <a href="https://www.linkedin.com/in/${id}/"><div><figure data-view-name="image"><img alt="${name}’s profile picture"></figure></div></a>
    <div><div><p>${name}</p>${headline === null ? "" : line(headline)}${sent === null ? "" : line(sent)}</div></div>
    <div>${withdraw ? `<a href="https://www.linkedin.com/" aria-label="Withdraw invitation sent to ${name}" data-view-name="sent-invitations-withdraw-single"><span><span>Withdraw</span></span></a>` : ""}</div>
  </div></div>`;
}

function page(rows: string, { lang = "en", extra = "" } = {}) {
  return `<html lang="${lang}"><body><header data-testid="primary-nav"></header><main><section aria-label="Primary content">
    <nav><ul><li><a href="https://www.linkedin.com/mynetwork/invitation-manager/received">Received</a></li><li><a aria-current="true" href="https://www.linkedin.com/mynetwork/invitation-manager/sent">Sent</a></li></ul></nav>
    <div data-sdui-screen="${SCREEN}">${extra}<div data-testid="lazy-column">${rows}</div></div>
  </section></main></body></html>`;
}

describe("parseSentInvitations on hand-written pages", () => {
  it("reads an invitation row into a card with its sent line and withdraw control", () => {
    expect(parseSentInvitations(page(row()))).toEqual([
      {
        publicId: "person-1",
        profileUrl: "https://www.linkedin.com/in/person-1/",
        fullName: "Person 1",
        headline: "Engineer at Company 1",
        location: null,
        company: null,
        degree: null,
        sentText: "Sent 4 months ago",
        canWithdraw: true,
      },
    ]);
  });

  it("reads a row without a Withdraw control", () => {
    expect(parseSentInvitations(page(row({ withdraw: false })))[0]?.canWithdraw).toBe(false);
  });

  it("reads a row with no headline", () => {
    expect(parseSentInvitations(page(row({ headline: null })))[0]).toMatchObject({ headline: null, sentText: "Sent 4 months ago" });
  });

  it("returns an empty list on a page that says there are no pending invitations (wording unverified)", () => {
    expect(parseSentInvitations(page("", { extra: "<h2>No pending invitations</h2>" }))).toEqual([]);
  });

  it("throws ParseError on an invitations page with no rows and no notice", () => {
    expect(() => parseSentInvitations(page(""))).toThrow(/no invitation rows/);
  });

  it("throws ParseError on a page that is not the sent invitations page", () => {
    const received =
      '<html lang="en"><body><div data-sdui-screen="com.linkedin.sdui.flagshipnav.mynetwork.invitations.InvitationReceived"></div></body></html>';

    expect(() => parseSentInvitations(received)).toThrow(ParseError);
    expect(() => parseSentInvitations(received)).toThrow(/sent invitations: not the sent invitations page/);
  });

  it("throws ParseError naming the row when a name is missing", () => {
    expect(() => parseSentInvitations(page(row() + row({ id: "person-2", name: "" })))).toThrow(/invitation 2: no name/);
  });

  it("throws ParseError naming the row when the profile link is missing", () => {
    const broken = row({ id: "person-2" }).replace("https://www.linkedin.com/in/person-2/", "https://www.linkedin.com/company/x/");

    expect(() => parseSentInvitations(page(row() + broken))).toThrow(/invitation 2: no profile link/);
  });

  it("never returns the user himself", () => {
    const cards = parseSentInvitations(page(row() + row({ id: "me-myself" })), { selfPublicId: "me-myself" });

    expect(cards.map((card) => card.publicId)).toEqual(["person-1"]);
  });

  it("reads an Italian page (wording unverified)", () => {
    const italian = row({ name: "Persona 1", headline: "Ingegnere", sent: "Inviato 4 mesi fa" })
      .replace(/ data-view-name="sent-invitations-withdraw-single"/, "")
      .replace("Withdraw invitation sent to", "Ritira l’invito inviato a");

    expect(parseSentInvitations(page(italian, { lang: "it" }))[0]).toMatchObject({
      fullName: "Persona 1",
      headline: "Ingegnere",
      sentText: "Inviato 4 mesi fa",
      canWithdraw: true,
    });
  });

  it("returns an empty list on an Italian page with no pending invitations (wording unverified)", () => {
    expect(parseSentInvitations(page("", { lang: "it", extra: "<p>Nessun invito in sospeso</p>" }))).toEqual([]);
  });
});

describe("parseSentInvitations on the committed fixture", () => {
  const html = readFileSync(new URL("../../../fixtures/invitations/sent-en.html", import.meta.url), "utf8");
  const cards = parseSentInvitations(html);

  it("reads every pending invitation the capture had", () => {
    expect(cards).toHaveLength(2);
  });

  it("gives each card its required fields, its sent line and a Withdraw control", () => {
    for (const card of cards) {
      expect(card.profileUrl).toBe(`https://www.linkedin.com/in/${card.publicId}/`);
      expect(card.publicId).toMatch(/^person-\d+$/);
      expect(card.fullName).toMatch(/^Person \d+$/);
      expect(card.headline).not.toBeNull();
      expect(card).toMatchObject({ degree: null, sentText: "Sent 4 months ago", canWithdraw: true });
    }
  });
});
