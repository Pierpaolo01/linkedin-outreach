/** Tests on saved pages and invented dialogs only: the write operations are NOT VERIFIED ON THE LIVE SITE. */
import { describe, expect, it } from "vitest";
import { accessibleName, findAll, openDialogs, parseHtml } from "./markup";
import { writeStructure, writeWordingFor } from "./selectors.write";
import { CONNECT_PROFILE, fixture, overlay } from "./testPages";

const en = writeWordingFor("en");

describe("openDialogs on saved pages", () => {
  it("does not count the closed <dialog>s and the aria-hidden video dialogs of a saved profile", () => {
    const html = fixture(CONNECT_PROFILE);
    expect(html).toMatch(/<dialog[\s>]/);
    expect(html).toContain('role="dialog"');

    expect(openDialogs(parseHtml(html))).toEqual([]);
  });

  it("counts a dialog shown over the page", () => {
    const root = parseHtml(overlay(fixture(CONNECT_PROFILE), "synthetic-invite-choose-en.html"));

    expect(openDialogs(root)).toHaveLength(1);
  });
});

describe("findAll on saved pages", () => {
  it("finds Connect in the top card only, not in the sticky header above it", () => {
    const root = parseHtml(fixture(CONNECT_PROFILE));
    const everywhere = findAll(root, { roles: ["button", "link"], name: en.connect });
    const inTopCard = findAll(root, { roles: ["button", "link"], name: en.connect, within: writeStructure.topCard });

    // The top card holds two layouts of its actions; a stylesheet hides one, which saved HTML cannot show.
    expect(inTopCard).toHaveLength(2);
    expect(everywhere.length).toBeGreaterThan(inTopCard.length);
    expect(inTopCard.map((el) => accessibleName(el, root))).toEqual(["Invite Person 1 to connect", "Invite Person 1 to connect"]);
  });

  it("skips the buttons of closed dialogs", () => {
    const root = parseHtml(fixture(CONNECT_PROFILE));

    expect(findAll(root, { roles: ["button"], name: /^dismiss$/i })).toEqual([]);
  });

  it("finds the message box and the Send button of the conversation, not the recipient search box", () => {
    const root = parseHtml(fixture("messaging/synthetic-new-message-en.html"));

    expect(findAll(root, { roles: ["textbox"] })).toHaveLength(2);
    expect(findAll(root, { roles: ["textbox"], within: writeStructure.messageForm })).toHaveLength(1);
    expect(findAll(root, { roles: ["button"], name: en.sendMessage, within: writeStructure.messageForm })).toHaveLength(1);
  });

  it("names a field by its label", () => {
    const root = parseHtml(overlay(fixture(CONNECT_PROFILE), "synthetic-invite-note-en.html"));
    const [box] = findAll(root, { roles: ["textbox"], within: writeStructure.dialog });

    expect(box === undefined ? null : accessibleName(box, root)).toBe("Your note");
  });
});
