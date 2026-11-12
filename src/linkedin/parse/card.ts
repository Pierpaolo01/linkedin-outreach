/**
 * A card: the summary of a person as LinkedIn shows it in a list
 * (recommendations, search results, connections, sent invitations).
 * Shared by every list parser. Fields LinkedIn does not show are null.
 */
export interface Card {
  /** The `<id>` in linkedin.com/in/<id>. Identifies the person. */
  readonly publicId: string;
  /** Canonical: https://www.linkedin.com/in/<id>/ with no query string. */
  readonly profileUrl: string;
  readonly fullName: string;
  readonly headline: string | null;
  readonly location: string | null;
  /** Current company, only where the list shows it separately from the headline. */
  readonly company: string | null;
  /** Connection degree: 1, 2 or 3 (3 covers "3rd+"). Null when the list does not show it. */
  readonly degree: 1 | 2 | 3 | null;
}

/** Thrown when a saved or live page does not have the structure a parser expects. */
export class ParseError extends Error {
  constructor(
    readonly page: string,
    message: string,
  ) {
    super(`${page}: ${message}`);
    this.name = "ParseError";
  }
}

/**
 * `/in/<id>/`, or `/in/<id>/<language>/`: LinkedIn links a member who also has a profile in another
 * language with that language after the id (seen 2026-11-12 in a search result: `/in/<id>/en/`).
 * Group 1 is the id either way.
 */
const PROFILE_PATH = /^\/in\/([^/?#]+)(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/?$/i;

/** A link's `href`, relative or absolute, resolved against linkedin.com. Undefined when it is not a URL. */
export function linkedInUrl(href: string): URL | undefined {
  try {
    return new URL(href, "https://www.linkedin.com");
  } catch {
    return undefined;
  }
}

/** The URL is on linkedin.com, with or without `www`. */
export function isLinkedInHost(url: URL): boolean {
  return url.hostname === "www.linkedin.com" || url.hostname === "linkedin.com";
}

/** Extracts the public identifier from a profile link, absolute or relative. Undefined for anything else. */
export function publicIdFromUrl(href: string): string | undefined {
  const url = linkedInUrl(href);
  if (url === undefined || !isLinkedInHost(url)) return undefined;
  const id = PROFILE_PATH.exec(url.pathname)?.[1];
  return id === undefined ? undefined : decodeURIComponent(id);
}

export function profileUrlFor(publicId: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`;
}

/**
 * The member id (`ACoA…`) in a Message control's link (`/messaging/compose/?…&recipient=<id>`).
 * It is how the messaging pages name a person; the vanity id of `/in/<id>/` does not appear there.
 */
export function memberIdFromComposeHref(href: string | null | undefined): string | null {
  if (href == null) return null;
  const url = linkedInUrl(href);
  if (url === undefined || !url.pathname.startsWith("/messaging/compose")) return null;
  const id = url.searchParams.get("recipient");
  return id !== null && /^ACoA[A-Za-z0-9_-]+$/.test(id) ? id : null;
}
