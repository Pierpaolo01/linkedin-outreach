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

const PROFILE_PATH = /^\/in\/([^/?#]+)\/?$/;

/** Extracts the public identifier from a profile link, absolute or relative. Undefined for anything else. */
export function publicIdFromUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, "https://www.linkedin.com");
  } catch {
    return undefined;
  }
  if (url.hostname !== "www.linkedin.com" && url.hostname !== "linkedin.com") return undefined;
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
  let url: URL;
  try {
    url = new URL(href, "https://www.linkedin.com");
  } catch {
    return null;
  }
  if (!url.pathname.startsWith("/messaging/compose")) return null;
  const id = url.searchParams.get("recipient");
  return id !== null && /^ACoA[A-Za-z0-9_-]+$/.test(id) ? id : null;
}
