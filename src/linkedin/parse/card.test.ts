import { describe, expect, it } from "vitest";
import { memberIdFromComposeHref } from "./card";

describe("memberIdFromComposeHref", () => {
  it("reads the recipient of a Message link", () => {
    expect(
      memberIdFromComposeHref("/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AID1&recipient=ACoAAmember_1-x&interop=msgOverlay"),
    ).toBe("ACoAAmember_1-x");
  });

  it.each([
    ["no link", undefined],
    ["a link without a recipient", "/messaging/compose/?profileUrn=x"],
    ["a recipient that is not a member id", "/messaging/compose/?recipient=person-1"],
    ["a link to another page", "/in/person-1/?recipient=ACoAAmember1"],
    ["something that is not a URL", "https://"],
  ])("gives null for %s", (_name, href) => {
    expect(memberIdFromComposeHref(href)).toBeNull();
  });
});
