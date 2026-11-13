/**
 * The read-only half of the driver (spec section 7): every operation paces
 * itself, loads one LinkedIn page, checks that the session is healthy, and
 * hands the page's HTML to a parser. Nothing here clicks or types.
 *
 * A login wall, checkpoint or restriction notice is a safety stop: the driver
 * throws the typed error and from then on refuses every operation with that
 * same error, without touching LinkedIn again.
 */
import type { Page } from "playwright";
import { ParseError, profileUrlFor } from "./parse/card";
import { parseConnections, type ConnectionCard } from "./parse/connections";
import { parseProfile, type Profile } from "./parse/profile";
import { parseRecommendations, type RecommendationsResult } from "./parse/recommendations";
import { parseSearchResults, type SearchResults } from "./parse/search";
import { parseSentInvitations, type SentInvitationCard } from "./parse/sentInvitations";
import { findThreadUrl, parseThread, type Thread } from "./parse/thread";
import { SearchCapped, Unexpected, type LinkedInError } from "./errors";
import { humanDelay, randomInt } from "./human";
import { assertHealthy, savePage, type HealthOptions, type InspectablePage } from "./pageHealth";
import { classifyPage, FEED_URL, settle, type PageClassification } from "./session";

const ORIGIN = "https://www.linkedin.com";
const SEARCH_PATH = "/search/results/people/";
const THREAD_URL = /^https:\/\/www\.linkedin\.com\/messaging\/thread\/[^/?#]+\/?/;

/** What the driver needs from the dedicated window. `load` navigates and returns once the page has settled. */
export interface DriverPage extends InspectablePage {
  load(url: string): Promise<void>;
}

/** Either keywords, or a people-search URL the user copied from LinkedIn (filters included). */
export type SearchQuery =
  | { readonly keywords: string; readonly page?: number }
  | { readonly url: string; readonly page?: number };

export interface ReadThreadResult extends Thread {
  /** `https://www.linkedin.com/messaging/thread/<id>/` when LinkedIn shows it, else null. */
  readonly threadUrl: string | null;
}

export interface ReadDriver {
  /** Opens the feed. Returns the ok classification, or throws the typed error for any other state. */
  ensureSession(): Promise<PageClassification>;
  searchPeople(query: SearchQuery): Promise<SearchResults>;
  /** The groups of My Network → Grow. */
  listRecommendations(): Promise<RecommendationsResult>;
  viewProfile(publicId: string): Promise<Profile>;
  /** Connections as LinkedIn lists them by default: recently added first. */
  listRecentConnections(): Promise<ConnectionCard[]>;
  listSentInvitations(): Promise<SentInvitationCard[]>;
  /**
   * The conversation with one person, opened by the member id their Message link carries. With no
   * conversation yet LinkedIn shows a new-message pane that names the person by `publicId` instead,
   * so pass it when known; the result then has `isNew` and no messages.
   */
  readThread(person: { readonly memberId: string; readonly publicId?: string }): Promise<ReadThreadResult>;
}

export interface LiveDriverDeps {
  readonly page: DriverPage;
  /** Waits before a page load so loads are spaced like a person's. */
  readonly pace: () => Promise<unknown>;
  readonly health?: HealthOptions;
}

const SAFETY_STOPS: readonly LinkedInError["kind"][] = ["logged_out", "checkpoint", "restricted", "limit_hit"];

export function createLiveDriver({ page, pace, health = {} }: LiveDriverDeps): ReadDriver {
  let stopped: LinkedInError | undefined;

  /** Paces, loads and health-checks one page; returns its HTML. */
  async function open(url: string): Promise<string> {
    if (stopped !== undefined) throw stopped;
    await pace();
    await page.load(url);
    try {
      await assertHealthy(page, health);
    } catch (error) {
      if (error instanceof Unexpected || !isLinkedInError(error)) throw error;
      if (SAFETY_STOPS.includes(error.kind)) stopped = error;
      throw error;
    }
    return page.content();
  }

  /**
   * Runs a parser; a page it cannot read is saved and reported as `Unexpected` (the parser's own
   * error, such as a profile that is not available, is its `cause`).
   */
  async function read<T>(html: string, parse: (html: string) => T): Promise<T> {
    try {
      return parse(html);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      const artifacts = await savePage(page, html, "unknown", health);
      throw new Unexpected(`${error.message}. Saved html ${artifacts.html}`, { artifacts, cause: error });
    }
  }

  return {
    async ensureSession() {
      if (stopped !== undefined) throw stopped;
      await pace();
      await page.load(FEED_URL);
      try {
        return await assertHealthy(page, health);
      } catch (error) {
        if (isLinkedInError(error) && SAFETY_STOPS.includes(error.kind)) stopped = error;
        throw error;
      }
    },

    async searchPeople(query) {
      const html = await open(searchUrl(query));
      const results = await read(html, (page) => parseSearchResults(page));
      if (results.capped) throw new SearchCapped("LinkedIn shows its monthly search limit notice");
      // A page with a result that was left out is kept, so the parser can be taught that result.
      if (results.skipped.length > 0) await savePage(page, html, "unknown", health);
      return results;
    },

    async listRecommendations() {
      return read(await open(`${ORIGIN}/mynetwork/grow/`), (html) => parseRecommendations(html));
    },

    async viewProfile(publicId) {
      return read(await open(profileUrlFor(publicId)), parseProfile);
    },

    async listRecentConnections() {
      return read(await open(`${ORIGIN}/mynetwork/invite-connect/connections/`), (html) => parseConnections(html));
    },

    async listSentInvitations() {
      return read(await open(`${ORIGIN}/mynetwork/invitation-manager/sent/`), (html) => parseSentInvitations(html));
    },

    async readThread({ memberId, publicId }) {
      if (!/^[A-Za-z0-9_-]+$/.test(memberId)) throw new RangeError("not a member id");
      const url = new URL(`${ORIGIN}/messaging/compose/`);
      url.searchParams.set("profileUrn", `urn:li:fsd_profile:${memberId}`);
      url.searchParams.set("recipient", memberId);
      const html = await open(url.href);
      const thread = await read(html, parseThread);
      // LinkedIn opens the newest conversation when it cannot open the one asked for: never report that one.
      // The new-message pane names nobody by id until the person has written; there the address bar,
      // still on the compose URL for this member, is the evidence.
      const shown = thread.participant.publicId;
      const stillComposing = thread.viaCompose && new URL(page.url()).searchParams.get("recipient") === memberId;
      const isThem = shown === null ? stillComposing : shown === memberId || (shown === publicId && stillComposing);
      if (!isThem) {
        const artifacts = await savePage(page, html, "unknown", health);
        throw new Unexpected(`the conversation shown is not with the person asked for. Saved html ${artifacts.html}`, {
          artifacts,
        });
      }
      const landed = THREAD_URL.exec(page.url())?.[0];
      return { ...thread, threadUrl: landed ?? findThreadUrl(html) };
    },
  };
}

function isLinkedInError(error: unknown): error is LinkedInError {
  return error instanceof Error && "kind" in error && typeof error.kind === "string";
}

function searchUrl(query: SearchQuery): string {
  let url: URL;
  if ("url" in query) {
    try {
      url = new URL(query.url);
    } catch {
      throw new RangeError("not a URL");
    }
    if (url.protocol !== "https:" || url.hostname !== "www.linkedin.com" || !url.pathname.startsWith(SEARCH_PATH)) {
      throw new RangeError("not a LinkedIn people-search URL");
    }
  } else {
    url = new URL(`${ORIGIN}${SEARCH_PATH}`);
    url.searchParams.set("keywords", query.keywords);
  }
  if (query.page !== undefined) {
    if (!Number.isInteger(query.page) || query.page < 1) throw new RangeError("page must be a whole number from 1");
    url.searchParams.set("page", String(query.page));
  }
  return url.href;
}

/**
 * The dedicated window as a `DriverPage`. After a healthy page settles it
 * scrolls slowly, as a reader would, so lists and profile sections that load
 * on scroll are in the HTML. It never clicks or types.
 */
export function driverPageFor(page: Page): DriverPage {
  return {
    async load(url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(page);
      await humanDelay({ minMs: 1_500, maxMs: 3_000 });
      if (classifyPage({ url: page.url(), html: await page.content() }).state !== "ok") return;
      // LinkedIn scrolls an inner column, so the wheel must be over the page content, not the corner.
      const size = await page.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }));
      await page.mouse.move(Math.round(size.width * 0.6), Math.round(size.height * 0.6));
      const scrolls = randomInt({ min: 4, max: 6 });
      for (let i = 0; i < scrolls; i += 1) {
        await page.mouse.wheel(0, randomInt({ min: 500, max: 900 }));
        await humanDelay({ minMs: 1_200, maxMs: 2_800 });
      }
    },
    url: () => page.url(),
    content: () => page.content(),
    screenshot: (options) => page.screenshot(options),
  };
}

/** Who an outreach action is aimed at: the public id opens the profile, the member id opens the conversation. */
export interface PersonRef {
  readonly publicId: string;
  readonly memberId: string;
}

/**
 * The driver reads the clock before each thing it does (a page load, typing, the click). Later
 * than `notAfter`, it does nothing more and returns "expired": a laptop that slept inside the
 * call must not act when it wakes.
 */
export interface SendGuard {
  readonly notAfter: Date;
}

/**
 * What the invite step found. Only `sent` means an invitation went out; `expired` means the
 * deadline had passed and nothing was done; the others are refusals the engine turns into needs
 * review.
 */
export type InviteResult = "sent" | "already_pending" | "already_connected" | "not_offered" | "expired";

export type WithdrawResult = "withdrawn" | "not_pending" | "expired";

/**
 * `sent`: the message went out. `thread_changed`: the conversation was not the one the caller
 * judged; nothing was sent. `expired`: the deadline had passed; nothing was sent.
 */
export type MessageResult = "sent" | "thread_changed" | "expired";

/**
 * The operations that change something on LinkedIn. Each resolves only once LinkedIn shows the
 * result. A throw means the result is not known: the click may have happened, so the caller
 * checks LinkedIn before it tries again. Each takes a deadline (`SendGuard`): a call the laptop
 * slept through must not click hours later, outside the working window. The live implementation is
 * `src/linkedin/write/`, joined with the reads in `src/worker/liveDriver.ts`.
 */
export interface WriteDriver {
  /** Throws `LimitHit` on LinkedIn's own invitation-limit message. `note` null sends without a note. */
  sendInvite(person: PersonRef, note: string | null, guard: SendGuard): Promise<InviteResult>;
  /**
   * Sends one message to a 1st-degree connection. Clears any draft left in the message box first.
   * `expected.messageCount` is how many messages the conversation showed when the caller judged it.
   * The driver compares it with the conversation it has open immediately before sending; if it
   * differs, nothing is sent and the result is "thread_changed". The deadline is checked at the
   * same moment, after typing; past it the draft is cleared and the result is "expired".
   */
  sendMessage(person: PersonRef, text: string, expected: SendGuard & { readonly messageCount: number }): Promise<MessageResult>;
  withdrawInvite(person: PersonRef, guard: SendGuard): Promise<WithdrawResult>;
}

export type Driver = ReadDriver & WriteDriver;
