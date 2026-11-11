/**
 * Selectors and interface wording for My Network → Grow (https://www.linkedin.com/mynetwork/grow/),
 * the recommendations page. Learnt from one saved page (English, 2026-11-11).
 *
 * The 2026 frontend uses hashed class names that change between deploys, so nothing here
 * selects on `class`. Structure, roles, `aria-current` and `href` patterns come first; wording
 * is used only where nothing else tells two things apart, and is stored the way
 * `normaliseText` produces it (lower-case, straight apostrophes, single spaces).
 */
import type { InterfaceLanguage } from "../selectors";

export const recommendationsStructural = {
  /** The page content; the sidebar and the ad dialogs sit inside it too, but carry no lists. */
  main: "main",
  /** The signed-in global navigation; if it links to a profile, that profile is the user's own. */
  signedInNav: '[data-testid="primary-nav"]',
  /** The current tab of the My Network sub-navigation ("Grow" / "Catch up"). */
  currentTab: 'a[aria-current="true"][href]',
  /** Path the current tab points to on the Grow page. */
  growPath: "/mynetwork/grow/",
  /** Each group (invitations, a row of suggestions, the grid) is a `section` holding one of these. */
  list: '[role="list"]',
  card: '[role="listitem"]',
  /** Group heading: `h3` for the rows ("People you may know from …"), `h2` for the grid and invitations. */
  heading: "h2, h3",
  /** "Show all" sits next to the heading as a link (href back to the Grow page, handled by script) or a button. */
  headerControl: "a, button",
  /** The received-invitations group links its "Show all" to the invitation manager. */
  invitationManagerPath: "/mynetwork/invitation-manager/",
  /** Profile links: `/in/<id>`. */
  link: "a[href]",
  /** Name, headline and insight lines are `p` elements. */
  textLine: "p",
  button: "button",
} as const;

export type RecommendationAction = "connect" | "follow" | "pending";

export interface RecommendationsWording {
  /** Visible text of the card's action button, per action. */
  readonly actions: Readonly<Record<RecommendationAction, readonly string[]>>;
  /**
   * Heading prefixes after which LinkedIn names the basis of the group (a company, school or place).
   * Longer prefixes first where one is a prefix of another.
   */
  readonly reasonPrefixes: readonly string[];
  /**
   * Insight lines naming a mutual connection; group 1 is that person's name.
   * Used by the fixture script to find names to scrub, not by the parser.
   */
  readonly mutualConnection: readonly RegExp[];
  /** Insight lines that are interface wording, not personal data. */
  readonly genericInsights: readonly string[];
}

const byLanguage = {
  en: {
    actions: {
      connect: ["connect"],
      follow: ["follow"],
      pending: ["pending"],
    },
    reasonPrefixes: [
      "people you may know from ",
      "people you may know in ",
      "people you may know at ", // unverified: not on the saved page
      "people who work at ", // unverified
      "people in ", // unverified
    ],
    mutualConnection: [/^(.+?) and \d+ other mutual connections?$/i, /^(.+?) is a mutual connection$/i],
    genericInsights: ["based on your profile", "based on your recent activity"],
  },
  it: {
    actions: {
      connect: ["collegati"], // unverified
      follow: ["segui"], // unverified
      pending: ["in sospeso", "in attesa"], // unverified
    },
    reasonPrefixes: [
      "persone che potresti conoscere di ", // unverified
      "persone che potresti conoscere da ", // unverified
      "persone che potresti conoscere presso ", // unverified
      "persone che potresti conoscere in ", // unverified
      "persone che potresti conoscere a ", // unverified
    ],
    mutualConnection: [
      /^(.+?) e altri \d+ collegamenti in comune$/i, // unverified
      /^(.+?) e un altro collegamento in comune$/i, // unverified
      /^(.+?) è un collegamento in comune$/i, // unverified
    ],
    genericInsights: ["in base al tuo profilo", "in base alla tua attività recente"], // unverified
  },
} as const satisfies Record<InterfaceLanguage, RecommendationsWording>;

export function recommendationsWordingFor(language: InterfaceLanguage): RecommendationsWording {
  return byLanguage[language];
}
