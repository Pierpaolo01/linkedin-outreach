/**
 * Typed driver errors (spec section 7). Every driver function returns typed
 * data or throws one of these; callers switch on `kind`.
 */
export type LinkedInErrorKind =
  | "logged_out"
  | "checkpoint"
  | "restricted"
  | "unexpected"
  | "limit_hit"
  | "search_capped";

/** The screenshot and HTML saved when the driver met a page it would not act on. */
export interface PageArtifacts {
  /** `undefined` when the screenshot itself failed (for example, the window was closed). */
  readonly screenshot: string | undefined;
  readonly html: string;
}

export interface LinkedInErrorOptions {
  readonly artifacts?: PageArtifacts;
  readonly cause?: unknown;
}

export abstract class LinkedInError extends Error {
  abstract readonly kind: LinkedInErrorKind;
  readonly artifacts: PageArtifacts | undefined;

  constructor(message: string, options: LinkedInErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.artifacts = options.artifacts;
  }
}

/** A login wall: the dedicated window is not signed in. Raises a safety stop. */
export class LoggedOut extends LinkedInError {
  readonly kind = "logged_out";
}

/** A checkpoint, CAPTCHA or verification challenge. Raises a safety stop. */
export class Checkpoint extends LinkedInError {
  readonly kind = "checkpoint";
}

/** A restriction or warning notice on the account. Raises a safety stop. */
export class Restricted extends LinkedInError {
  readonly kind = "restricted";
}

/** A page the driver does not recognise. The prospect goes to needs review. */
export class Unexpected extends LinkedInError {
  readonly kind = "unexpected";
}

/** LinkedIn's own invitation-limit message. Raises a safety stop. */
export class LimitHit extends LinkedInError {
  readonly kind = "limit_hit";
}

/** The monthly commercial-use search cap. Discovery pauses until next month. */
export class SearchCapped extends LinkedInError {
  readonly kind = "search_capped";
}
