import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ParseError } from "./card";
import { parseProfile, ProfileUnavailableError, type Profile } from "./profile";

function fixture(name: string): string {
  return readFileSync(new URL(`../../../fixtures/profile/${name}`, import.meta.url), "utf8");
}

/**
 * Scrubbed from two real profiles saved 2026-11-11, both people the user is not
 * connected to (3rd degree; Message, Follow and More, no Connect). The expected
 * values are what the parser read from the captures before scrubbing.
 */
const fixtures = [
  { name: "not-connected-a-en.html", experience: 1, firstEntryHasLocation: true, firstEntryHasDescription: true },
  { name: "not-connected-b-en.html", experience: 3, firstEntryHasLocation: false, firstEntryHasDescription: false },
] as const;

const nullableString = (value: unknown) => value === null || typeof value === "string";

describe.each(fixtures)("parseProfile on $name", (f) => {
  const profile: Profile = parseProfile(fixture(f.name));

  it("reads the owner's identity from the top card", () => {
    expect(profile.publicId).toMatch(/^person-\d+$/);
    expect(profile.profileUrl).toBe(`https://www.linkedin.com/in/${profile.publicId}/`);
    expect(profile.fullName).toMatch(/^Person \d+$/);
  });

  it("finds headline, location and About", () => {
    for (const field of [profile.headline, profile.location, profile.about]) {
      expect(typeof field).toBe("string");
      expect(field?.length).toBeGreaterThan(0);
    }
  });

  it("sees a 3rd-degree person who can be followed and messaged but shows no Connect", () => {
    expect(profile.degree).toBe(3);
    expect(profile.connectionState).toBe("follow_only");
    expect(profile.messageAvailable).toBe(true);
  });

  it("reads the experience entries the page shows, the newest current one as title and company", () => {
    expect(profile.experience).toHaveLength(f.experience);
    for (const entry of profile.experience) {
      expect(typeof entry.title).toBe("string");
      expect(typeof entry.company).toBe("string");
      expect(entry.dateRange).toMatch(/\d{4}/);
      expect(typeof entry.current).toBe("boolean");
      expect(nullableString(entry.location)).toBe(true);
      expect(nullableString(entry.description)).toBe(true);
    }
    const [first] = profile.experience;
    expect(first?.current).toBe(true);
    expect(first?.location !== null).toBe(f.firstEntryHasLocation);
    expect(first?.description !== null).toBe(f.firstEntryHasDescription);
    expect(profile.currentTitle).toBe(first?.title);
    expect(profile.currentCompany).toBe(first?.company);
  });
});

/** A hand-written page in the structure of the 2026 profile (seen 2026-11-11), with no hashed classes. */
function page(options: { readonly lang?: string; readonly body: string }): string {
  return `<!DOCTYPE html><html lang="${options.lang ?? "en"}"><head><title>Test</title></head><body>
<div data-testid="primary-nav"><nav><ul><li><button data-view-name="navigation-settings"><img alt="Signed In User"><span>Signed In User</span></button></li></ul></nav></div>
<div data-sdui-screen="com.linkedin.sdui.flagshipnav.profile.Profile"><main id="workspace"><section aria-label="Primary content">
<div data-view-name="profile-main-level">${options.body}</div></section></main></div></body></html>`;
}

interface TopCardOptions {
  readonly id?: string;
  readonly name?: string;
  readonly degree?: string;
  readonly headline?: string;
  readonly location?: string;
  readonly actions?: string;
}

function topCard(o: TopCardOptions = {}): string {
  const id = o.id ?? "test-person";
  return `<div data-view-name="profile-top-card"><section>
<a href="https://www.linkedin.com/" data-view-name="profile-top-card-member-photo"><div aria-label="Profile photo"></div></a>
<div><div><div><div data-view-name="profile-top-card-verified-badge"><div><h2>${o.name ?? "Test Person"}</h2></div></div>${o.degree === undefined ? "" : `<p>${o.degree}</p>`}</div>
<p>${o.headline ?? "Owner at Test Company"}</p><p>Test Company · Test School</p>
<div><p>${o.location ?? "Brescia, Lombardy, Italy"}</p><p>·</p><p><a href="https://www.linkedin.com/in/${id}/overlay/contact-info/">Contact info</a></p></div></div></div>
<div><p>350</p><p>connections</p></div>
<div>${o.actions ?? followActions}</div>
</section></div>`;
}

const message = (label = "Message") =>
  `<div data-view-name="profile-primary-message"><a aria-disabled="false" href="/messaging/compose/?recipient=x"><span>${label}</span></a></div>`;
const more = (label = "More") =>
  `<div data-view-name="profile-overflow-button"><button type="button" aria-expanded="false"><span>${label}</span></button></div>`;
const followActions = `${message()}<div data-view-name="relationship-building-button"><div data-view-name="edge-creation-follow-action"><button type="button" aria-label="Follow Test Person"><span>Follow</span></button></div></div>${more()}`;

const about = `<div data-view-name="profile-card-about"><section><h2>About</h2><p><span data-testid="expandable-text-box">We build and restore houses.<br>Since 1990.<button data-testid="expandable-text-button" type="button">… more</button></span></p></section></div>`;

/** One company with two roles (grouped in `ul > li`), then a past role at another company. */
const experience = `<div data-view-name="profile-card-experience"><section><h2>Experience</h2><div data-component-type="LazyColumn">
<div componentkey="entity-collection-item-1"><figure></figure><p>Group Company</p><p>49 yrs 10 mos</p><ul>
<li><p>Owner</p><p>Jan 1984 - Present · 42 yrs 11 mos</p><p>Present</p><a href="https://www.linkedin.com/in/test-person/overlay/Position/1/treasury/" data-view-name="experience-see-media-button"><p>A media title</p></a></li>
<li><p>Builder</p><p>Feb 1977 - Present · 49 yrs 10 mos</p><p>Treviso, Veneto, Italy</p><p>Present</p><p><span data-testid="expandable-text-box">Restoration work.<button data-testid="expandable-text-button">… more</button></span></p></li>
</ul></div>
<div componentkey="entity-collection-item-2"><hr role="presentation"><figure></figure><p>Site manager</p><p>Old Company · Full-time</p><p>2001 – 2005</p><p>Milan, Italy</p></div>
</div></section></div>`;

describe("parseProfile on hand-written pages", () => {
  it("reads About and Experience, newest first, with roles of one company under that company", () => {
    const profile = parseProfile(page({ body: topCard() + about + experience }));
    expect(profile.about).toBe("We build and restore houses.\nSince 1990.");
    expect(profile.experience).toEqual([
      { title: "Owner", company: "Group Company", dateRange: "Jan 1984 - Present · 42 yrs 11 mos", current: true, location: null, description: null },
      { title: "Builder", company: "Group Company", dateRange: "Feb 1977 - Present · 49 yrs 10 mos", current: true, location: "Treviso, Veneto, Italy", description: "Restoration work." },
      { title: "Site manager", company: "Old Company", dateRange: "2001 – 2005", current: false, location: "Milan, Italy", description: null },
    ]);
    expect(profile.currentTitle).toBe("Owner");
    expect(profile.currentCompany).toBe("Group Company");
  });

  it("treats a newline in the HTML source as a space; only <br> breaks a line", () => {
    const wrapped = `<div data-view-name="profile-card-about"><section><h2>About</h2><p><span data-testid="expandable-text-box">We build
   houses.<br>Since 1990.</span></p></section></div>`;
    expect(parseProfile(page({ body: topCard() + wrapped })).about).toBe("We build houses.\nSince 1990.");
  });

  it("gives null and an empty list for a profile with no About and no Experience", () => {
    const profile = parseProfile(page({ body: topCard() }));
    expect(profile.about).toBeNull();
    expect(profile.experience).toEqual([]);
    expect(profile.currentTitle).toBeNull();
    expect(profile.currentCompany).toBeNull();
    expect(profile.headline).toBe("Owner at Test Company");
    expect(profile.location).toBe("Brescia, Lombardy, Italy");
  });

  it("keeps the first five experience entries", () => {
    const item = (n: number) =>
      `<div componentkey="entity-collection-item-${n}"><p>Role ${n}</p><p>Company ${n}</p><p>201${n} – 201${n + 1}</p></div>`;
    const many = `<div data-view-name="profile-card-experience"><section><h2>Experience</h2>${[1, 2, 3, 4, 5, 6, 7].map(item).join("")}</section></div>`;
    const profile = parseProfile(page({ body: topCard() + many }));
    expect(profile.experience.map((e) => e.title)).toEqual(["Role 1", "Role 2", "Role 3", "Role 4", "Role 5"]);
    expect(profile.currentTitle).toBeNull();
  });
});

const relationship = (inner: string) => `<div data-view-name="relationship-building-button">${inner}</div>`;
const connectButton = (label = "Connect", aria = "Invite Test Person to connect") =>
  relationship(`<div data-view-name="edge-creation-connect-action"><button type="button" aria-label="${aria}"><span>${label}</span></button></div>`);

describe("parseProfile connection state", () => {
  it("is follow_only when the top card shows Follow and More but no Connect (the menu is not in the markup)", () => {
    const profile = parseProfile(page({ body: topCard({ degree: "· 3rd", actions: followActions }) }));
    expect(profile.connectionState).toBe("follow_only");
    expect(profile.messageAvailable).toBe(true);
    expect(profile.degree).toBe(3);
  });

  it("is can_connect when a Connect button is in the top card", () => {
    const profile = parseProfile(page({ body: topCard({ degree: "· 2nd", actions: connectButton() + more() }) }));
    expect(profile.connectionState).toBe("can_connect");
    expect(profile.messageAvailable).toBe(false);
  });

  it("is not fooled by Connect buttons on other people's cards outside the top card", () => {
    const sidebar = `<aside>${connectButton("Connect", "Invite Someone Else to connect")}</aside>`;
    const profile = parseProfile(page({ body: topCard({ actions: followActions }) + sidebar }));
    expect(profile.connectionState).toBe("follow_only");
  });

  it("is connect_in_more when the rendered More menu holds Connect", () => {
    const menu = `<div data-view-name="profile-overflow-button"><button aria-expanded="true"><span>More</span></button>
<div role="menu"><div role="menuitem" aria-label="Invite Test Person to connect"><p>Connect</p></div><div role="menuitem"><p>Save to PDF</p></div></div></div>`;
    const profile = parseProfile(page({ body: topCard({ actions: message() + relationship(`<div data-view-name="edge-creation-follow-action"><button>Follow</button></div>`) + menu }) }));
    expect(profile.connectionState).toBe("connect_in_more");
  });

  it("is pending when an invitation was already sent", () => {
    const pending = relationship(`<div><button type="button" aria-label="Pending, click to withdraw invitation sent to Test Person"><span>Pending</span></button></div>`);
    const profile = parseProfile(page({ body: topCard({ degree: "· 2nd", actions: pending + more() }) }));
    expect(profile.connectionState).toBe("pending");
  });

  it("is connected on a 1st-degree profile where Message is the primary action", () => {
    const profile = parseProfile(page({ body: topCard({ degree: "· 1st", actions: message() + more() }) }));
    expect(profile.degree).toBe(1);
    expect(profile.connectionState).toBe("connected");
    expect(profile.messageAvailable).toBe(true);
  });

  it("is unknown when the top card has no actions it recognises", () => {
    const profile = parseProfile(page({ body: topCard({ actions: "" }) }));
    expect(profile.connectionState).toBe("unknown");
    expect(profile.messageAvailable).toBe(false);
  });

  it("reads Italian button wording and degree when the page is in Italian", () => {
    const italianConnect = relationship(`<div><button type="button" aria-label="Invita Test Person a collegarsi"><span>Collegati</span></button></div>`);
    const profile = parseProfile(
      page({ lang: "it", body: topCard({ degree: "· 2°", actions: `${message("Messaggio")}${italianConnect}${more("Altro")}` }) }),
    );
    expect(profile.degree).toBe(2);
    expect(profile.connectionState).toBe("can_connect");
    expect(profile.messageAvailable).toBe(true);
  });

  it("reads an Italian pending button", () => {
    const pending = relationship(`<div><button type="button"><span>In sospeso</span></button></div>`);
    const profile = parseProfile(page({ lang: "it", body: topCard({ degree: "· 2°", actions: pending }) }));
    expect(profile.connectionState).toBe("pending");
  });
});

describe("parseProfile errors", () => {
  it("throws ParseError on a page that is not a profile", () => {
    const feed = `<!DOCTYPE html><html lang="en"><body><div data-testid="primary-nav"></div><main><h2>Feed</h2></main></body></html>`;
    expect(() => parseProfile(feed)).toThrow(ParseError);
    expect(() => parseProfile(feed)).toThrow(/not a profile/);
  });

  it("throws a distinguishable ParseError on the profile-not-available page", () => {
    const unavailable = `<!DOCTYPE html><html lang="en"><body><main><h1>This profile is not available</h1><p>The profile you're trying to view is unavailable.</p></main></body></html>`;
    expect(() => parseProfile(unavailable)).toThrow(ProfileUnavailableError);
    expect(() => parseProfile(unavailable)).toThrow(ParseError);
    expect(() => parseProfile(unavailable)).toThrow(/profile not available/);
  });

  it("throws ParseError when the top card has no name", () => {
    const broken = page({ body: `<div data-view-name="profile-top-card"><section><p>nothing here</p></section></div>` });
    expect(() => parseProfile(broken)).toThrow(/top card has no name/);
  });

  it("reads the owner from the top card, not the signed-in user in the navigation", () => {
    const profile = parseProfile(page({ body: topCard({ id: "test-person", name: "Test Person", degree: "· 2nd" }) }));
    expect(profile.fullName).toBe("Test Person");
    expect(profile.publicId).toBe("test-person");
    expect(profile.profileUrl).toBe("https://www.linkedin.com/in/test-person/");
  });
});
