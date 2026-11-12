/**
 * LinkedIn for `npm start` with `LINKEDIN_DRIVER=live`: one dedicated window, shared by the
 * engine's driver and the session checks, opened the first time either needs it, and used by one
 * of them at a time.
 */
import type { Driver, ReadDriver } from "../engine/ports";
import type { DriverPage } from "../linkedin/driver";
import { createLiveDriver } from "../linkedin/driver";
import { createLiveSessionPort, type LiveWindow, type SessionPort } from "../server/sessionPort";

const NO_SENDS =
  "Sends are not available in this build: invites, messages and withdrawals on the live site arrive in a later milestone";

/**
 * The engine's terms on the live site in this milestone: reads only.
 *
 * Deliberate, and not switchable by any environment variable or setting: the engine runs with
 * `outreach: false`, so it picks no invite, message, follow-up, withdrawal, connections check or
 * thread read, and the driver it is given has write operations that throw without touching
 * LinkedIn, so even a bug in the engine cannot send. Invites, messages and withdrawals on the real
 * site arrive in a later milestone (handoff section 6, milestone 4), and will change this function.
 */
export function readOnlyLinkedIn(read: () => ReadDriver): { readonly driver: () => Driver; readonly outreach: false } {
  return {
    outreach: false,
    driver: () => {
      const reads = read();
      return {
        // Only the read operations are taken from `reads`, even when it is a whole Driver.
        ensureSession: () => reads.ensureSession(),
        searchPeople: (query) => reads.searchPeople(query),
        listRecommendations: () => reads.listRecommendations(),
        viewProfile: (publicId) => reads.viewProfile(publicId),
        listRecentConnections: () => reads.listRecentConnections(),
        listSentInvitations: () => reads.listSentInvitations(),
        readThread: (person) => reads.readThread(person),
        sendInvite: () => Promise.reject(new Error(NO_SENDS)),
        sendMessage: () => Promise.reject(new Error(NO_SENDS)),
        withdrawInvite: () => Promise.reject(new Error(NO_SENDS)),
      };
    },
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
  readonly outreach: false;
  /** Opens the dedicated window if it is not open (again, if the user closed it). Throws `ProfileInUse`. */
  readonly window: () => Promise<void>;
}

export function createLiveLinkedIn<W extends LiveWindow>(deps: LiveLinkedInDeps<W>): LiveLinkedIn {
  let current: { readonly window: W; readonly page: DriverPage } | undefined;
  let opening: Promise<W> | undefined;

  /** The open window; opens one if there is none or its page was closed. Concurrent callers share one open. */
  async function windowNow(): Promise<W> {
    if (current !== undefined && !current.window.page.isClosed()) return current.window;
    opening ??= (async () => {
      try {
        if (current !== undefined) await current.window.close().catch(() => undefined);
        current = undefined;
        const window = await deps.open();
        current = { window, page: deps.pageFor(window.page) };
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

  // The engine's reads and the session checks load pages in the same window: one at a time, or a
  // Re-check pressed during a read would navigate away from the page being read.
  const turn = oneAtATime();

  const sessionPort = createLiveSessionPort({
    open: windowNow,
    ...(deps.sessionPace === undefined ? {} : { pace: deps.sessionPace }),
    ...(deps.screenshotsDir === undefined ? {} : { screenshotsDir: deps.screenshotsDir }),
  });

  const live = readOnlyLinkedIn(() => {
    const reads = createLiveDriver({
      page,
      pace: deps.pace,
      ...(deps.screenshotsDir === undefined ? {} : { health: { screenshotsDir: deps.screenshotsDir } }),
    });
    return {
      ensureSession: () => turn(() => reads.ensureSession()),
      searchPeople: (query) => turn(() => reads.searchPeople(query)),
      listRecommendations: () => turn(() => reads.listRecommendations()),
      viewProfile: (publicId) => turn(() => reads.viewProfile(publicId)),
      listRecentConnections: () => turn(() => reads.listRecentConnections()),
      listSentInvitations: () => turn(() => reads.listSentInvitations()),
      readThread: (person) => turn(() => reads.readThread(person)),
    };
  });

  return {
    sessionPort: {
      check: () => turn(() => sessionPort.check()),
      async close() {
        const open = current;
        current = undefined;
        await open?.window.close();
      },
    },
    driver: live.driver,
    outreach: live.outreach,
    window: async () => {
      await windowNow();
    },
  };
}
