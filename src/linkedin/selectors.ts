/**
 * The single file of LinkedIn selectors, URL patterns and interface wording.
 * When LinkedIn changes its pages, this is the file to edit.
 *
 * Prefer URL and structural markers (stable attributes) over visible text.
 * Visible text is kept per interface language and stored lower-case with
 * straight apostrophes, the form `normaliseText` produces.
 */

export const INTERFACE_LANGUAGES = ["en", "it"] as const;
export type InterfaceLanguage = (typeof INTERFACE_LANGUAGES)[number];

/** An HTML attribute that identifies an element, usable on saved HTML and as a CSS selector. */
export interface AttributeMarker {
  readonly attribute: string;
  readonly value: string;
  /** `exact` matches the whole value; `contains` matches a substring of it. */
  readonly match: "exact" | "contains";
}

function marker(attribute: string, value: string, match: AttributeMarker["match"] = "exact") {
  return { attribute, value, match } satisfies AttributeMarker;
}

/** Signals that do not depend on the interface language. */
export const structural = {
  /** URL path prefixes LinkedIn uses for the login wall. */
  loggedOutPaths: ["/login", "/uas/login", "/authwall", "/signup"],
  /** The logged-out home page (a signed-in visit to `/` redirects to the feed). */
  loggedOutHomePaths: ["/", "/home"],
  /** URL path prefix of every checkpoint: verification, CAPTCHA, restriction appeal. */
  checkpointPath: "/checkpoint/",
  /** Path of the feed `ensureSession` opens. */
  feedPath: "/feed/",
  /** The signed-in global navigation bar at the top of every logged-in page. */
  /** `primary-nav` is the 2026 frontend (seen live on the feed 2026-11-11); `global-nav` is the older one. */
  signedInNav: [marker("data-testid", "primary-nav"), marker("id", "global-nav")],
  /** The email and password fields of the login form, on the login page and the authwall. */
  loginForm: [marker("name", "session_key"), marker("name", "session_password")],
  /** CAPTCHA and challenge widgets. */
  captcha: [
    marker("id", "captcha-internal"),
    marker("src", "arkoselabs", "contains"),
    marker("src", "funcaptcha", "contains"),
    marker("class", "g-recaptcha", "contains"),
    marker("class", "h-captcha", "contains"),
  ],
} as const;

export interface LanguageSelectors {
  /** Notices LinkedIn shows on a restricted or warned account. */
  readonly restrictedNotices: readonly string[];
  /** Headings of the security-check (CAPTCHA) page. */
  readonly securityCheck: readonly string[];
}

const byLanguage = {
  en: {
    restrictedNotices: [
      "your account has been restricted",
      "your account has been temporarily restricted",
      "your account is temporarily restricted",
      "your account is restricted",
      "we've restricted your account",
      "we've temporarily restricted your account",
      "we've detected the use of software that automates activity",
    ],
    securityCheck: ["let's do a quick security check", "quick security check"],
  },
  it: {
    restrictedNotices: [
      "il tuo account è stato limitato",
      "il tuo account è stato temporaneamente limitato",
      "il tuo account è temporaneamente limitato",
      "il tuo account è limitato",
      "abbiamo limitato il tuo account",
      "abbiamo temporaneamente limitato il tuo account",
      "abbiamo rilevato l'uso di software che automatizza le attività",
    ],
    securityCheck: ["facciamo un rapido controllo di sicurezza", "rapido controllo di sicurezza"],
  },
} as const satisfies Record<InterfaceLanguage, LanguageSelectors>;

export function selectorsFor(language: InterfaceLanguage): LanguageSelectors {
  return byLanguage[language];
}

/** Maps an `<html lang>` value to a supported interface language. Unsupported or missing → English. */
export function languageFromLang(lang: string | null | undefined): InterfaceLanguage {
  const primary = (lang ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return INTERFACE_LANGUAGES.find((language) => language === primary) ?? "en";
}

/** Reads `<html lang>` from saved HTML. */
export function languageFromHtml(html: string): InterfaceLanguage {
  const htmlTag = /<html\b[^>]*>/i.exec(html)?.[0] ?? "";
  const lang = /\slang\s*=\s*["']?([^"'\s>]+)/i.exec(htmlTag)?.[1];
  return languageFromLang(lang);
}

/** The slice of a Playwright `Page` the language pick needs. */
export interface HasHtmlElement {
  locator(selector: string): { getAttribute(name: string): Promise<string | null> };
}

/** Reads `<html lang>` from a live page. */
export async function pageLanguage(page: HasHtmlElement): Promise<InterfaceLanguage> {
  return languageFromLang(await page.locator("html").getAttribute("lang"));
}

/** The CSS selector for a marker, for `page.locator` and `page.waitForSelector`. */
export function cssFor(m: AttributeMarker): string {
  return `[${m.attribute}${m.match === "contains" ? "*=" : "="}${JSON.stringify(m.value)}]`;
}

/** Lower-case, straight apostrophes, single spaces: the form the wording above is stored in. */
export function normaliseText(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
