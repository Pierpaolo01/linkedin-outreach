import {
  INTERFACE_LANGUAGES,
  cssFor,
  normaliseText,
  selectorsFor,
  structural,
  type AttributeMarker,
} from "./selectors";

/** The session states a page can show. `search_capped` comes from the search driver, not from here. */
export type SessionState = "ok" | "logged_out" | "checkpoint" | "restricted" | "unknown";

export interface PageClassification {
  readonly state: SessionState;
  /** What matched, for logs and the safety-stop banner. Never holds query strings or page text beyond the matched phrase. */
  readonly evidence: string;
}

export interface PageSnapshot {
  readonly url: string;
  readonly html: string;
}

export const FEED_URL = `https://www.linkedin.com${structural.feedPath}`;

/**
 * Classifies a LinkedIn page from its URL and HTML. Pure: works the same on a
 * live page and on a saved fixture.
 *
 * Order matters. Restriction wording wins over everything (it is the most
 * serious and can appear on signed-in pages and on /checkpoint/ pages alike),
 * then checkpoint URLs and security-check wording, then the login wall, then
 * the signed-in navigation, then CAPTCHA widgets on pages that are neither. Stop wording is matched in every supported language, whatever
 * the page declares, because a missed stop costs more than a false one.
 */
export function classifyPage({ url, html }: PageSnapshot): PageClassification {
  const parsed = parseUrl(url);
  if (parsed === undefined) return { state: "unknown", evidence: "not a URL" };
  if (!isLinkedInHost(parsed.hostname)) {
    return { state: "unknown", evidence: `not a LinkedIn page (${parsed.protocol}//${parsed.hostname})` };
  }

  const path = parsed.pathname;
  const markup = withoutHiddenContent(html);
  const text = visibleText(markup);

  const restricted = findPhrase(text, (language) => selectorsFor(language).restrictedNotices);
  if (restricted !== undefined) return { state: "restricted", evidence: restricted };

  if (path.startsWith(structural.checkpointPath)) {
    return { state: "checkpoint", evidence: `url path ${path}` };
  }
  const securityCheck = findPhrase(text, (language) => selectorsFor(language).securityCheck);
  if (securityCheck !== undefined) return { state: "checkpoint", evidence: securityCheck };

  if (structural.loggedOutPaths.some((prefix) => isUnder(path, prefix))) {
    return { state: "logged_out", evidence: `url path ${path}` };
  }
  const loginForm = findMarker(markup, structural.loginForm);
  if (loginForm !== undefined) return { state: "logged_out", evidence: loginForm };

  const signedInNav = findMarker(markup, structural.signedInNav);
  if (signedInNav !== undefined) return { state: "ok", evidence: signedInNav };

  // A CAPTCHA widget counts only on a page that is neither the login wall nor signed in:
  // the login page and the signed-in messaging page both embed an invisible reCAPTCHA.
  const captcha = findMarker(markup, structural.captcha);
  if (captcha !== undefined) return { state: "checkpoint", evidence: captcha };

  if (structural.loggedOutHomePaths.some((home) => trimSlash(path) === trimSlash(home))) {
    return { state: "logged_out", evidence: `logged-out home page ${path}` };
  }

  return { state: "unknown", evidence: `no session signal on ${path}` };
}

/** The slice of a Playwright `Page` that `ensureSession` uses. */
export interface SessionPage {
  goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
  waitForLoadState(state: "load", options?: { timeout?: number }): Promise<void>;
  waitForSelector(selector: string, options?: { state?: "attached"; timeout?: number }): Promise<unknown>;
  url(): string;
  content(): Promise<string>;
}

/** Any element whose presence tells the classifier something. */
const SETTLED_SELECTOR = [...structural.signedInNav, ...structural.loginForm, ...structural.captcha]
  .map(cssFor)
  .join(", ");

/**
 * Opens the feed, waits for it to settle and classifies it. Returns the state
 * rather than throwing for a logged-out window: callers decide what to do.
 */
export async function ensureSession(page: SessionPage): Promise<PageClassification> {
  await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await settle(page);
  return classifyPage({ url: page.url(), html: await page.content() });
}

/** Waits for the load event and for a recognisable element; gives up quietly so a slow page still gets classified. */
export async function settle(page: Pick<SessionPage, "waitForLoadState" | "waitForSelector">): Promise<void> {
  await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForSelector(SETTLED_SELECTOR, { state: "attached", timeout: 10_000 }).catch(() => undefined);
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function isLinkedInHost(hostname: string): boolean {
  return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Drops comments and the bodies of elements the user never sees as text (LinkedIn embeds translation bundles in them). Opening tags stay, so `src` markers on scripts still count. */
function withoutHiddenContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|code|template|noscript)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, "<$1$2></$1>");
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
  agrave: "à",
  egrave: "è",
  eacute: "é",
  igrave: "ì",
  ograve: "ò",
  ugrave: "ù",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

function visibleText(markup: string): string {
  return normaliseText(decodeEntities(markup.replace(/<[^>]*>/g, " ")));
}

function findPhrase(
  text: string,
  phrasesFor: (language: (typeof INTERFACE_LANGUAGES)[number]) => readonly string[],
): string | undefined {
  for (const language of INTERFACE_LANGUAGES) {
    const phrase = phrasesFor(language).find((candidate) => text.includes(candidate));
    if (phrase !== undefined) return `text "${phrase}" (${language})`;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markerPattern({ attribute, value, match }: AttributeMarker): RegExp {
  const name = escapeRegExp(attribute);
  const v = escapeRegExp(value);
  const quoted =
    match === "exact" ? `(?:"${v}"|'${v}'|${v}(?=[\\s/>]))` : `(?:"[^"]*${v}[^"]*"|'[^']*${v}[^']*')`;
  return new RegExp(`<[a-z][^>]*\\s${name}\\s*=\\s*${quoted}`, "i");
}

function findMarker(markup: string, markers: readonly AttributeMarker[]): string | undefined {
  const found = markers.find((m) => markerPattern(m).test(markup));
  return found === undefined ? undefined : `marker ${cssFor(found)}`;
}
