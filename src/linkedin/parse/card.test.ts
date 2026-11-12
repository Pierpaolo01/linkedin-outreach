import { describe, expect, it } from "vitest";
import { memberIdFromComposeHref, publicIdFromUrl } from "./card";

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

describe("publicIdFromUrl", () => {
  it.each([
    ["a relative profile link", "/in/person-1/"],
    ["an absolute link with a query", "https://www.linkedin.com/in/person-1/?miniProfileUrn=abc"],
    // Seen 2026-11-12 in a search result: a member with a profile in a second language is linked as /in/<id>/en/.
    ["a link with a language suffix", "https://www.linkedin.com/in/person-1/en/"],
    ["a language suffix with no closing slash", "/in/person-1/en"],
    ["a language suffix with a region (not seen on a real page)", "/in/person-1/pt-br/"],
  ])("reads the public identifier from %s", (_name, href) => {
    expect(publicIdFromUrl(href)).toBe("person-1");
  });

  it.each([
    ["a section of a profile", "/in/person-1/details/experience/"],
    ["a profile overlay", "/in/person-1/overlay/contact-info/"],
    ["something after the language suffix", "/in/person-1/en/details/experience/"],
    ["a company page", "/company/company-1/"],
    ["a profile path on another site", "https://example.com/in/person-1/"],
  ])("gives undefined for %s", (_name, href) => {
    expect(publicIdFromUrl(href)).toBeUndefined();
  });
});
