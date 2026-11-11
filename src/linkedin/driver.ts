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
import { findThreadUrl, parseConversationList, parseThread, type ConversationSummary, type Thread } from "./parse/thread";
import { Unexpected, type LinkedInError } from "./errors";
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
  /** The messaging page: its conversation list, and the conversation it opens by itself (the newest), if any. */
  listConversations(): Promise<{ readonly conversations: ConversationSummary[]; readonly open: Thread | null }>;
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

const SAFETY_STOPS: readonly LinkedInError["kind"][] = ["logged_out", "checkpoint", "restricted"];

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

  /** Runs a parser; a page it cannot read is saved and reported as `Unexpected`. */
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
      const url = searchUrl(query);
      return read(await open(url), (html) => parseSearchResults(html));
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

    async listConversations() {
      const html = await open(`${ORIGIN}/messaging/`);
      const conversations = await read(html, parseConversationList);
      let openThread: Thread | null;
      try {
        openThread = parseThread(html);
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
        openThread = null;
      }
      return { conversations, open: openThread };
    },

    async readThread({ memberId, publicId }) {
      if (!/^[A-Za-z0-9_-]+$/.test(memberId)) throw new RangeError("not a member id");
      const url = new URL(`${ORIGIN}/messaging/compose/`);
      url.searchParams.set("profileUrn", `urn:li:fsd_profile:${memberId}`);
      url.searchParams.set("recipient", memberId);
      const html = await open(url.href);
      const thread = await read(html, parseThread);
      // LinkedIn opens the newest conversation when it cannot open the one asked for: never report that one.
      const shown = thread.participant.publicId;
      if (shown === null || (shown !== memberId && shown !== publicId)) {
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
