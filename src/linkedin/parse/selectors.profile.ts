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
 * Wording is stored in the form `normaliseText` produces: lower case,
 * straight apostrophes, single spaces. Both captures so far are English; an
 * Italian string marked `// unverified` has not been seen on a real page.
 */
import type { InterfaceLanguage } from "../selectors";

/** Seen 2026-11-11 on two profiles of people the user is not connected to. */
export const profileStructure = {
  /** The page wrapper names the screen. */
  screen: '[data-sdui-screen="com.linkedin.sdui.flagshipnav.profile.Profile"]',
  /** The owner's card at the top of the main column. Everything about the owner is read inside it. */
  topCard: '[data-view-name="profile-top-card"]',
  /** Wraps the owner's name heading. */
  nameBadge: '[data-view-name="profile-top-card-verified-badge"]',
  /** The "Contact info" link sits in the location row and carries the owner's `/in/<id>/`. */
  contactInfoLink: 'a[href*="/overlay/contact-info"]',
  /** The bar that appears on scroll; its first link is the owner's profile. Fallback for the id. */
  stickyHeaderLink: '[data-view-name="profile-sticky-header"] a[href]',
  /** Holds Message (a link to `/messaging/compose/`). */
  message: '[data-view-name="profile-primary-message"]',
  /** Holds the one relationship action: Follow or Connect (and, by the same pattern, Pending). */
  relationship: '[data-view-name="relationship-building-button"]',
  connectAction: '[data-view-name="edge-creation-connect-action"]',
  followAction: '[data-view-name="edge-creation-follow-action"]',
  /** Not seen: a guess following the pattern above. Wording below is the fallback. */
  pendingAction: '[data-view-name="edge-creation-pending-action"], [data-view-name="edge-creation-withdraw-action"]',
  /** The More button. Its menu is not in the saved markup until it is clicked. */
  overflow: '[data-view-name="profile-overflow-button"]',
  /** A rendered menu, when one is present (not seen on the profile captures). */
  menu: '[role="menu"], [role="menuitem"]',
  about: '[data-view-name="profile-card-about"]',
  experience: '[data-view-name="profile-card-experience"]',
  /** The full text of a clamped paragraph (About, an experience description). */
  expandableText: '[data-testid="expandable-text-box"]',
  /** The "… more" toggle inside an expandable text; its wording is not part of the text. */
  expandableButton: '[data-testid="expandable-text-button"]',
  /** One entry of the experience list; a company with several roles holds them in `ul > li`. */
  experienceItem: '[componentkey^="entity-collection-item"]',
  /** The media thumbnail link inside a role; its text is not part of the role. */
  experienceMedia: '[data-view-name="experience-see-media-button"]',
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
  },
  it: {
    degrees: { "1°": 1, "2°": 2, "3°": 3, "3°+": 3 }, // unverified
    present: ["presente", "oggi"], // unverified
    connect: ["collegati", "invita"], // unverified
    pending: ["in sospeso", "ritira invito"], // unverified
    follow: ["segui"], // unverified
    message: ["messaggio"], // unverified
    unavailable: ["questo profilo non è disponibile", "profilo non disponibile", "questa pagina non esiste"], // unverified
  },
} as const satisfies Record<InterfaceLanguage, ProfileWording>;
