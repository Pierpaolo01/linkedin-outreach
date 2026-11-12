import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileInUse } from "../linkedin/browser";
import type { DriverPage } from "../linkedin/driver";
import { FEED_URL } from "../linkedin/session";
import type { LiveWindow } from "../server/sessionPort";
import { createLiveLinkedIn } from "./liveDriver";

const SIGNED_IN = '<html lang="en"><body><header id="global-nav"></header></body></html>';

/** One Chrome window as the test sees it: every navigation (`goto`) and driver page load, in order. */
interface StubWindow extends LiveWindow {
  readonly visits: string[];
  closed: boolean;
}

function stubWindow(visits: string[]): StubWindow {
  let url = "about:blank";
  const window: StubWindow = {
    visits,
    closed: false,
    page: {
      goto: async (next: string) => {
        visits.push(`goto ${next}`);
        url = next;
      },
      waitForLoadState: async () => undefined,
      waitForSelector: async () => undefined,
      url: () => url,
      content: async () => SIGNED_IN,
      screenshot: async () => undefined,
      isClosed: () => window.closed,
    },
    close: async () => {
      window.closed = true;
    },
  };
  return window;
}

let screenshotsDir: string;
beforeEach(() => {
  screenshotsDir = mkdtempSync(join(tmpdir(), "lo-live-"));
});
afterEach(() => {
  rmSync(screenshotsDir, { recursive: true, force: true });
});

function setup({ open }: { open?: () => Promise<StubWindow> } = {}) {
  const visits: string[] = [];
  const windows: StubWindow[] = [];
  /** A driver page load waits on this when set. */
  let gate: Promise<void> | undefined;
  const live = createLiveLinkedIn({
    open:
      open ??
      (async () => {
        const window = stubWindow(visits);
        windows.push(window);
        return window;
      }),
    pageFor: (page): DriverPage => ({
      async load(url) {
        visits.push("driver load");
        await gate;
        await page.goto(url);
        visits.push("driver done");
      },
      url: () => page.url(),
      content: () => page.content(),
      screenshot: (options) => page.screenshot(options),
    }),
    pace: async () => undefined,
    sessionPace: async () => 0,
    screenshotsDir,
  });
  return {
    live,
    visits,
    windows,
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

describe("the shared dedicated window", () => {
  it("opens nothing until the first page load, then serves the driver and the session checks from one window", async () => {
    const { live, windows, visits } = setup();
    const driver = live.driver();
    expect(windows).toHaveLength(0);

    await driver.ensureSession();
    await live.sessionPort.check();
    await live.driver().ensureSession();

    expect(windows).toHaveLength(1);
    expect(visits).toEqual(["driver load", `goto ${FEED_URL}`, "driver done", `goto ${FEED_URL}`, "driver load", `goto ${FEED_URL}`, "driver done"]);
  });

  it("lets a session check load the feed only after the engine's read in flight has finished", async () => {
    const { live, visits, hold } = setup();
    await live.window();
    const release = hold();

    const read = live.driver().ensureSession();
    await new Promise((resolve) => setImmediate(resolve));
    const check = live.sessionPort.check();
    await new Promise((resolve) => setImmediate(resolve));
    expect(visits).toEqual(["driver load"]);

    release();
    await Promise.all([read, check]);
    expect(visits).toEqual(["driver load", `goto ${FEED_URL}`, "driver done", `goto ${FEED_URL}`]);
  });

  it("opens the window again when the user has closed it", async () => {
    const { live, windows } = setup();
    await live.window();
    const first = windows[0];
    if (first === undefined) throw new Error("no window");
    first.closed = true;

    await live.window();
    expect(windows).toHaveLength(2);
  });

  it("reports another process's window as ProfileInUse", async () => {
    const { live } = setup({
      open: async () => {
        throw new ProfileInUse("/data/chrome-profile", { host: "mac", pid: 4242 });
      },
    });

    await expect(live.window()).rejects.toThrow(ProfileInUse);
  });

  it("closes the window when the session port is closed", async () => {
    const { live, windows } = setup();
    await live.window();
    await live.sessionPort.close();
    expect(windows[0]?.closed).toBe(true);
  });

  it("refuses every write: the live site is read-only in this build", async () => {
    const { live, windows } = setup();
    const person = { publicId: "someone", memberId: "ACoASomeone" };
    const guard = { notAfter: new Date() };

    expect(live.outreach).toBe(false);
    await expect(live.driver().sendInvite(person, "Hi", guard)).rejects.toThrow(/not available in this build/);
    await expect(live.driver().sendMessage(person, "Hi", { ...guard, messageCount: 0 })).rejects.toThrow(/not available in this build/);
    await expect(live.driver().withdrawInvite(person, guard)).rejects.toThrow(/not available in this build/);
    expect(windows).toHaveLength(0);
  });
});
