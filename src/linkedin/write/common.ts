/**
 * NOT VERIFIED ON THE LIVE SITE.
 *
 * What the three write operations share: opening a page (paced, then health-checked), the deadline,
 * and giving up on a page they do not recognise (saved, then `Unexpected`).
 */
import { ParseError } from "../parse/card";
import { Unexpected } from "../errors";
import { assertHealthy, savePage, type HealthOptions } from "../pageHealth";
import { languageFromHtml } from "../selectors";
import type { SendGuard } from "../driver";
import { openDialogs, parseHtml } from "./markup";
import type { WritePage } from "./page";
import { writeWordingFor, type WriteWording } from "./selectors.write";

export interface WriteDeps {
  readonly page: WritePage;
  /** Waits before a page load so loads are spaced like a person's. */
  readonly pace: () => Promise<unknown>;
  readonly health?: HealthOptions;
  /** How long LinkedIn gets to show the result of a click. Default 15 s. */
  readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Not verified on the live site. */
export function timeoutOf(deps: WriteDeps): number {
  return deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

/** Later than the deadline: the operation does nothing more. Read right before each step. Not verified on the live site. */
export function pastDeadline(page: WritePage, guard: SendGuard): boolean {
  return page.now().getTime() > guard.notAfter.getTime();
}

/** For `clickUnless`: "expired" past the deadline, read at the last moment before the click. Not verified on the live site. */
export function expiryOf(page: WritePage, guard: SendGuard): () => Promise<"expired" | undefined> {
  return async () => (pastDeadline(page, guard) ? "expired" : undefined);
}

/** Paces, loads and health-checks one page (a login wall or checkpoint throws its typed error); returns its HTML. Not verified on the live site. */
export async function openPage(deps: WriteDeps, url: string): Promise<string> {
  await deps.pace();
  await deps.page.load(url);
  await assertHealthy(deps.page, deps.health ?? {});
  return deps.page.content();
}

/** The interface wording of the page shown. Not verified on the live site. */
export function wordingOf(html: string): WriteWording {
  return writeWordingFor(languageFromHtml(html));
}

/**
 * Gives up on the page shown: a login wall, checkpoint or restriction throws its own typed error
 * (a click can lead to one); anything else is saved and reported as `Unexpected`.
 * Not verified on the live site.
 */
export async function giveUp(deps: WriteDeps, message: string, cause?: unknown): Promise<never> {
  const health = deps.health ?? {};
  await assertHealthy(deps.page, health);
  const html = await deps.page.content();
  const artifacts = await savePage(deps.page, html, "unknown", health);
  throw new Unexpected(`${message}. Saved html ${artifacts.html}`, cause === undefined ? { artifacts } : { artifacts, cause });
}

/** Runs a parser on the page; a page it cannot read is given up on. Not verified on the live site. */
export async function readPage<T>(deps: WriteDeps, html: string, parse: (html: string) => T): Promise<T> {
  try {
    return parse(html);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    return giveUp(deps, error.message, error);
  }
}

/** Runs a parser and returns undefined when it cannot read the page (for checks inside a wait). Not verified on the live site. */
export function tryParse<T>(html: string, parse: (html: string) => T): T | undefined {
  try {
    return parse(html);
  } catch (error) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
}

/** Not verified on the live site. */
export function hasOpenDialog(html: string): boolean {
  return openDialogs(parseHtml(html)).length > 0;
}

/** Closes an open menu or dialog with Escape and waits for it to go; true when it went. Not verified on the live site. */
export async function closeDialog(deps: WriteDeps): Promise<boolean> {
  await deps.page.dismiss();
  return (await deps.page.waitFor((html) => (hasOpenDialog(html) ? undefined : true), timeoutOf(deps))) === true;
}
