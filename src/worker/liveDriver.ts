/**
 * LinkedIn for `npm start` with `LINKEDIN_DRIVER=live`: one dedicated window, shared by the
 * engine's driver and the session checks, opened the first time either needs it, and used by one
 * of them at a time.
 */
import type { Driver, ReadDriver, WriteDriver } from "../engine/ports";
import type { DriverPage } from "../linkedin/driver";
import { createLiveDriver } from "../linkedin/driver";
import { LinkedInError } from "../linkedin/errors";
import type { WriteDeps } from "../linkedin/write/common";
import { createWriteDriver } from "../linkedin/write/driver";
import type { WritePage } from "../linkedin/write/page";
import { createLiveSessionPort, type LiveWindow, type SessionPort } from "../server/sessionPort";

/** Errors after which nothing more may touch LinkedIn until the user resumes (decision 18). */
const SAFETY_STOPS: ReadonlySet<LinkedInError["kind"]> = new Set(["logged_out", "checkpoint", "restricted", "limit_hit"]);

/**
 * Joins the read and write halves into one `Driver` with one latch: a login wall, checkpoint,
 * restriction or LinkedIn's invitation limit met by any operation makes every later operation, read
 * or write, throw that same error without touching LinkedIn. Each half keeps its own latch as well.
 */
export function sharedLatch(reads: ReadDriver, writes: WriteDriver): Driver {
  let stopped: LinkedInError | undefined;
  function latched<A extends unknown[], T>(act: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
    return async (...args) => {
      if (stopped !== undefined) throw stopped;
      try {
        return await act(...args);
      } catch (error) {
        if (error instanceof LinkedInError && SAFETY_STOPS.has(error.kind)) stopped = error;
        throw error;
      }
    };
  }
  return {
    ensureSession: latched(() => reads.ensureSession()),
    searchPeople: latched((query) => reads.searchPeople(query)),
    listRecommendations: latched(() => reads.listRecommendations()),
    viewProfile: latched((publicId) => reads.viewProfile(publicId)),
    listRecentConnections: latched(() => reads.listRecentConnections()),
    listSentInvitations: latched(() => reads.listSentInvitations()),
    readThread: latched((person) => reads.readThread(person)),
    sendInvite: latched((person, note, guard) => writes.sendInvite(person, note, guard)),
    sendMessage: latched((person, text, expected) => writes.sendMessage(person, text, expected)),
    withdrawInvite: latched((person, guard) => writes.withdrawInvite(person, guard)),
  };
}

/** Runs one job at a time, in the order asked. A job that fails does not stop the next. */
function oneAtATime(): <T>(job: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return (job) => {
    const run = last.then(job, job);
    last = run.catch(() => undefined);
    return run;
  };
}

export interface LiveLinkedInDeps<W extends LiveWindow> {
  /** Opens the dedicated window (`openDedicatedWindow`). Throws `ProfileInUse` when another process has it. */
  readonly open: () => Promise<W>;
  /** The window's page as the driver uses it (`driverPageFor`). */
  readonly pageFor: (page: W["page"]) => DriverPage;
  /** The window's page as the write operations use it (`writePageFor`). */
  readonly writePageFor: (page: W["page"]) => WritePage;
  /** Builds the write half. Default `createWriteDriver`; tests pass a stand-in. */
  readonly writeDriver?: (deps: WriteDeps) => WriteDriver;
  /** Waits before each page load the driver makes, so loads are spaced like a person's. */
  readonly pace: () => Promise<unknown>;
  /** Waits before a session check's feed load. Default: the session port's own. */
  readonly sessionPace?: () => Promise<number>;
  readonly screenshotsDir?: string;
}

export interface LiveLinkedIn {
  /** For the session checks (start-up and Re-check). Its `close` closes the dedicated window. */
  readonly sessionPort: SessionPort;
  /** For the runner. */
  readonly driver: () => Driver;
  /** Invites, messages, follow-ups and withdrawals run on the live site. */
  readonly outreach: true;
  /** Opens the dedicated window if it is not open (again, if the user closed it). Throws `ProfileInUse`. */
  readonly window: () => Promise<void>;
}

export function createLiveLinkedIn<W extends LiveWindow>(deps: LiveLinkedInDeps<W>): LiveLinkedIn {
  let current: { readonly window: W; readonly page: DriverPage; readonly writePage: WritePage } | undefined;
  let opening: Promise<W> | undefined;

  /** The open window; opens one if there is none or its page was closed. Concurrent callers share one open. */
  async function windowNow(): Promise<W> {
    if (current !== undefined && !current.window.page.isClosed()) return current.window;
    opening ??= (async () => {
      try {
        if (current !== undefined) await current.window.close().catch(() => undefined);
        current = undefined;
        const window = await deps.open();
        current = { window, page: deps.pageFor(window.page), writePage: deps.writePageFor(window.page) };
        return window;
      } finally {
        opening = undefined;
      }
    })();
    return opening;
  }

  function pageNow(): DriverPage {
    if (current === undefined) throw new Error("the dedicated window is not open");
    return current.page;
  }

  function writePageNow(): WritePage {
    if (current === undefined) throw new Error("the dedicated window is not open");
    return current.writePage;
  }

  /** The driver's view of whichever window is open now. A page load opens the window when needed. */
  const page: DriverPage = {
    async load(url) {
      await windowNow();
      await pageNow().load(url);
    },
    url: () => pageNow().url(),
    content: () => pageNow().content(),
    screenshot: (options) => pageNow().screenshot(options),
  };

  /** The write operations' view of whichever window is open now. A page load opens the window when needed. */
  const writePage: WritePage = {
    async load(url) {
      await windowNow();
      await writePageNow().load(url);
    },
    count: (target) => writePageNow().count(target),
    click: (target) => writePageNow().click(target),
    clickUnless: (target, refuse) => writePageNow().clickUnless(target, refuse),
    type: (target, text) => writePageNow().type(target, text),
    clear: (target) => writePageNow().clear(target),
    value: (target) => writePageNow().value(target),
    dismiss: () => writePageNow().dismiss(),
    waitFor: (check, timeoutMs) => writePageNow().waitFor(check, timeoutMs),
    now: () => writePageNow().now(),
    url: () => writePageNow().url(),
    content: () => writePageNow().content(),
    screenshot: (options) => writePageNow().screenshot(options),
  };

  // The engine's reads and the session checks load pages in the same window: one at a time, or a
  // Re-check pressed during a read would navigate away from the page being read.
  const turn = oneAtATime();

  const sessionPort = createLiveSessionPort({
    open: windowNow,
    ...(deps.sessionPace === undefined ? {} : { pace: deps.sessionPace }),
    ...(deps.screenshotsDir === undefined ? {} : { screenshotsDir: deps.screenshotsDir }),
  });

  const health = deps.screenshotsDir === undefined ? {} : { health: { screenshotsDir: deps.screenshotsDir } };
  const makeWrites = deps.writeDriver ?? createWriteDriver;

  // A new driver (with a fresh latch) each time the runner asks: after the user resumes a safety stop.
  const driver = (): Driver => {
    const reads = createLiveDriver({ page, pace: deps.pace, ...health });
    const writes = makeWrites({ page: writePage, pace: deps.pace, ...health });
    // Reads, writes and session checks share one window: one at a time, so a Re-check pressed
    // during a send cannot navigate away from the dialog being filled in.
    return sharedLatch(
      {
        ensureSession: () => turn(() => reads.ensureSession()),
        searchPeople: (query) => turn(() => reads.searchPeople(query)),
        listRecommendations: () => turn(() => reads.listRecommendations()),
        viewProfile: (publicId) => turn(() => reads.viewProfile(publicId)),
        listRecentConnections: () => turn(() => reads.listRecentConnections()),
        listSentInvitations: () => turn(() => reads.listSentInvitations()),
        readThread: (person) => turn(() => reads.readThread(person)),
      },
      {
        sendInvite: (person, note, guard) => turn(() => writes.sendInvite(person, note, guard)),
        sendMessage: (person, text, expected) => turn(() => writes.sendMessage(person, text, expected)),
        withdrawInvite: (person, guard) => turn(() => writes.withdrawInvite(person, guard)),
      },
    );
  };

  return {
    sessionPort: {
      check: () => turn(() => sessionPort.check()),
      async close() {
        const open = current;
        current = undefined;
        await open?.window.close();
      },
    },
    driver,
    outreach: true,
    window: async () => {
      await windowNow();
    },
  };
}
