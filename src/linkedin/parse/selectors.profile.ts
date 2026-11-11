/**
 * Selectors and interface wording for a person's profile page. When LinkedIn
 * changes the profile, this is the file to edit.
 *
 * LinkedIn's 2026 frontend hashes its class names and changes them between
 * deploys, so nothing here selects on a class. The hooks are, in order of
 * preference: `data-sdui-screen` (names the page), `data-view-name` and
 * `data-testid` (name components), roles, `href` patterns, and only where
 * nothing else exists, visible wording.
 *
 * `data-view-name` is written only into the first page a browser session loads;
 * every later load of the same page has none (seen 2026-11-11). Every
 * `data-view-name` hook below that the parser relies on comes with a hook
 * present on both loads: `componentkey`, `data-testid`, `href` patterns,
 * headings or document structure.
 *
 * Wording is stored in the form `normaliseText` produces: lower case,
 * straight apostrophes, single spaces. Both captures so far are English; an
 * Italian string marked `// unverified` has not been seen on a real page.
 */
import type { InterfaceLanguage } from "../selectors";

const nameBadge = '[data-view-name="profile-top-card-verified-badge"]';
const primaryMessage = '[data-view-name="profile-primary-message"]';

/** Seen 2026-11-11 on two profiles of people the user is not connected to. */
export const profileStructure = {
  /** The page wrapper names the screen. */
  screen: '[data-sdui-screen="com.linkedin.sdui.flagshipnav.profile.Profile"]',
  /** The owner's card at the top of the main column. Everything about the owner is read inside it. First loads only. */
  topCard: '[data-view-name="profile-top-card"]',
  /**
   * Each card of the page, the top card included, sits in one of these on any load
   * (`componentkey="com.linkedin.sdui.profile.card.ref<member id>"`). The top card is the one
   * holding the Contact info link. Seen 2026-11-11. The prefix stops before "ref": fixtures
   * have the rest replaced by TOKEN.
   */
  profileCard: '[componentkey^="com.linkedin.sdui.profile.card."]',
  /** Wraps the owner's name heading. */
  nameBadge,
  /** The owner's name heading inside its badge wrapper. First loads only. */
  name: `${nameBadge} h2`,
  /** The owner's name on any load: the top card's first `h2`. */
  nameFallback: "h2",
  /** The "Contact info" link sits in the location row and carries the owner's `/in/<id>/`. */
  contactInfoLink: 'a[href*="/overlay/contact-info"]',
  /** The bar that appears on scroll; its first link is the owner's profile. Fallback for the id. */
  stickyHeaderLink: '[data-view-name="profile-sticky-header"] a[href]',
  /** What follows `/in/<id>/` in the Contact info link's href; stripped to read the id. */
  contactInfoSuffix: /overlay\/contact-info\/?.*$/,
  /** Holds Message (a link to `/messaging/compose/`). First loads only. */
  message: primaryMessage,
  /** The Message link inside it; its href names the member id. */
  messageLink: `${primaryMessage} a[href]`,
  /** The Message control inside it, link or button. */
  messageControls: `${primaryMessage} a, ${primaryMessage} button`,
  /** The Message control on any load; a 2nd-degree page may show it as a secondary action. Seen 2026-11-11. */
  composeLink: 'a[href*="/messaging/compose/"]',
  /** Holds the one relationship action: Follow or Connect (and, by the same pattern, Pending). */
  relationship: '[data-view-name="relationship-building-button"]',
  connectAction: '[data-view-name="edge-creation-connect-action"]',
  /** Connect on any load: a link to `/preload/custom-invite/?vanityName=<id>`. Seen 2026-11-11 on a later load. */
  connectLink: 'a[href*="/custom-invite/"]',
  followAction: '[data-view-name="edge-creation-follow-action"]',
  /** Not seen: a guess following the pattern above. Wording below is the fallback. */
  pendingAction: '[data-view-name="edge-creation-pending-action"], [data-view-name="edge-creation-withdraw-action"]',
  /** The More button. Its menu is not in the saved markup until it is clicked. */
  overflow: '[data-view-name="profile-overflow-button"]',
  /** A rendered menu, when one is present (not seen on the profile captures). */
  menu: '[role="menu"], [role="menuitem"]',
  /** Every control of the top card, in the card or in a rendered menu; read by their wording. */
  controls: 'button, a, [role="menuitem"]',
  /** Where the "profile not available" page puts its wording (below). */
  unavailableHeadings: "h1, h2, h3, title",
  /** First loads only; on any load the card whose heading is the About wording below. */
  about: '[data-view-name="profile-card-about"]',
  /** First loads only; on any load the card whose heading is the Experience wording below. */
  experience: '[data-view-name="profile-card-experience"]',
  /** A card's heading. */
  cardHeading: "h2",
  /** Name, headline, location, degree badges, About and role lines are `p` elements. */
  textLine: "p",
  /** The full text of a clamped paragraph (About, an experience description). */
  expandableText: '[data-testid="expandable-text-box"]',
  /** The "… more" toggle inside an expandable text; its wording is not part of the text. */
  expandableButton: '[data-testid="expandable-text-button"]',
  /** One entry of the experience list; a company with several roles holds them in `ul > li`. */
  experienceItem: '[componentkey^="entity-collection-item"]',
  /** A role inside an experience item that groups several roles at one company. */
  experienceGroupRole: "ul > li",
  /** The role a paragraph belongs to, inside such a group. */
  experienceRole: "li",
  /** The media thumbnail link inside a role; its text is not part of the role. On any load its href ends in `/treasury/` (seen 2026-11-11). */
  experienceMedia: '[data-view-name="experience-see-media-button"], a[href*="/treasury/"]',
  /**
   * Seen 2026-11-11: a top card can hold two degree badges ("· 1st" and "· 2nd"), one of them
   * wrapped in this slot. On a 1st-degree connection's page the badge outside the slot said 1st;
   * on a page offering Connect it said 2nd. So the badge outside the slot is read first.
   */
  degreeSlot: "[data-display-contents]",
} as const;

export const MAX_EXPERIENCE = 5;

export interface ProfileWording {
  /** The degree badge next to the name, without the leading "·". */
  readonly degrees: Readonly<Record<string, 1 | 2 | 3>>;
  /** The word that ends a current role's date range ("2010 – Present"). */
  readonly present: readonly string[];
  /** Visible text or aria-label start of a Connect control. */
  readonly connect: readonly string[];
  /** Visible text or aria-label start of the control shown after an invitation was sent. */
  readonly pending: readonly string[];
  readonly follow: readonly string[];
  readonly message: readonly string[];
  /** Headings of the page LinkedIn shows for a profile that does not exist or is hidden. */
  readonly unavailable: readonly string[];
  /** Card headings, to find a card where no `data-view-name` names it. */
  readonly headings: { readonly about: readonly string[]; readonly experience: readonly string[] };
}

export const profileWording = {
  en: {
    degrees: { "1st": 1, "2nd": 2, "3rd": 3, "3rd+": 3 },
    present: ["present"],
    // "connect" seen as button text; "invite <name> to connect" seen as aria-label on cards of the same page.
    connect: ["connect", "invite"],
    pending: ["pending", "withdraw invitation"], // unverified on the 2026 profile
    follow: ["follow"],
    message: ["message"],
    unavailable: ["this profile is not available", "profile not available", "this page doesn't exist"], // unverified
    headings: { about: ["about"], experience: ["experience"] },
  },
  it: {
    degrees: { "1°": 1, "2°": 2, "3°": 3, "3°+": 3 }, // unverified
    present: ["presente", "oggi"], // unverified
    connect: ["collegati", "invita"], // unverified
    pending: ["in sospeso", "ritira invito"], // unverified
    follow: ["segui"], // unverified
    message: ["messaggio"], // unverified
    unavailable: ["questo profilo non è disponibile", "profilo non disponibile", "questa pagina non esiste"], // unverified
    headings: { about: ["informazioni"], experience: ["esperienza"] }, // unverified
  },
} as const satisfies Record<InterfaceLanguage, ProfileWording>;
