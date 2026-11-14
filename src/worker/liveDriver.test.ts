import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileInUse } from "../linkedin/browser";
import type { DriverPage, WriteDriver } from "../linkedin/driver";
import { Checkpoint, LimitHit, LoggedOut, Unexpected } from "../linkedin/errors";
import type { WritePage } from "../linkedin/write/page";
import { FEED_URL } from "../linkedin/session";
import type { LiveWindow } from "../server/sessionPort";
import { createLiveLinkedIn } from "./liveDriver";

const SIGNED_IN = '<html lang="en"><body><header id="global-nav"></header></body></html>';
const LOGIN_WALL = '<html lang="en"><body><form><input name="session_key"><input name="session_password"></form></body></html>';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** One Chrome window as the test sees it: every navigation (`goto`) and driver page load, in order. */
interface StubWindow extends LiveWindow {
  readonly visits: string[];
  closed: boolean;
}

function stubWindow(visits: string[], shown: () => string = () => SIGNED_IN): StubWindow {
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
      content: async () => shown(),
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
  /** Every write the stand-in write driver was asked to do, in order. */
  const writes: string[] = [];
  let html = SIGNED_IN;
  /** A driver page load waits on this when set. */
  let gate: Promise<void> | undefined;
  /** A write waits on this when set. */
  let writeGate: Promise<void> | undefined;
  /** The next write throws this instead of acting. */
  let writeFailure: Error | undefined;
  const live = createLiveLinkedIn({
    open:
      open ??
      (async () => {
        const window = stubWindow(visits, () => html);
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
    writePageFor: (page) => ({ load: (url: string) => page.goto(url) }) as unknown as WritePage,
    // Stands in for `createWriteDriver`: loads one page through the write page it is given, then records the write.
    writeDriver: ({ page }): WriteDriver => {
      async function act<T>(what: string, result: T): Promise<T> {
        visits.push("write load");
        await page.load("https://www.linkedin.com/in/someone/");
        await writeGate;
        const failure = writeFailure;
        writeFailure = undefined;
        if (failure !== undefined) throw failure;
        writes.push(what);
        visits.push("write done");
        return result;
      }
      return {
        sendInvite: (person, note) => act(`invite ${person.publicId}${note === null ? "" : ` ${note}`}`, "sent" as const),
        sendMessage: (person, text) => act(`message ${person.memberId} ${text}`, "sent" as const),
        withdrawInvite: (person) => act(`withdraw ${person.publicId}`, "withdrawn" as const),
      };
    },
    pace: async () => undefined,
    sessionPace: async () => 0,
    screenshotsDir,
  });
  return {
    live,
    visits,
    windows,
    writes,
    showPage: (next: string) => {
      html = next;
    },
    failWrite: (error: Error) => {
      writeFailure = error;
    },
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
    holdWrite: () => {
      let release: () => void = () => undefined;
      writeGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        writeGate = undefined;
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

  it("sends through the dedicated window, with outreach on", async () => {
    const { live, windows, writes } = setup();
    const person = { publicId: "someone", memberId: "ACoASomeone" };
    const guard = { notAfter: new Date(Date.now() + 60_000) };

    expect(live.outreach).toBe(true);
    await expect(live.driver().sendInvite(person, "Hi", guard)).resolves.toBe("sent");
    await expect(live.driver().sendMessage(person, "Hi", { ...guard, messageCount: 0 })).resolves.toBe("sent");
    await expect(live.driver().withdrawInvite(person, guard)).resolves.toBe("withdrawn");
    expect(windows).toHaveLength(1);
    expect(writes).toEqual(["invite someone Hi", "message ACoASomeone Hi", "withdraw someone"]);
  });

  it("lets a session check load the feed only after the send in flight has finished", async () => {
    const { live, visits, holdWrite } = setup();
    const person = { publicId: "someone", memberId: "ACoASomeone" };
    const release = holdWrite();
    const sending = live.driver().sendInvite(person, null, { notAfter: new Date(Date.now() + 60_000) });
    await tick();
    const checking = live.sessionPort.check();
    await tick();
    expect(visits.filter((v) => v === `goto ${FEED_URL}`)).toHaveLength(0);
    release();
    await sending;
    await checking;
    expect(visits.indexOf("write done")).toBeLessThan(visits.indexOf(`goto ${FEED_URL}`));
  });
});

describe("one safety latch for reads and writes", () => {
  const person = { publicId: "someone", memberId: "ACoASomeone" };
  const guard = { notAfter: new Date(Date.now() + 60_000) };

  it("a checkpoint met by a send stops every later read and send without loading anything", async () => {
    const { live, visits, failWrite } = setup();
    const driver = live.driver();
    failWrite(new Checkpoint("checkpoint after Send"));
    await expect(driver.sendInvite(person, "Hi", guard)).rejects.toBeInstanceOf(Checkpoint);
    const before = visits.length;
    await expect(driver.viewProfile("someone")).rejects.toBeInstanceOf(Checkpoint);
    await expect(driver.sendMessage(person, "Hi", { ...guard, messageCount: 0 })).rejects.toBeInstanceOf(Checkpoint);
    expect(visits.length).toBe(before);
  });

  it("LinkedIn's invitation limit met by a send stops reads too", async () => {
    const { live, failWrite } = setup();
    const driver = live.driver();
    failWrite(new LimitHit("weekly invitation limit"));
    await expect(driver.sendInvite(person, "Hi", guard)).rejects.toBeInstanceOf(LimitHit);
    await expect(driver.listSentInvitations()).rejects.toBeInstanceOf(LimitHit);
  });

  it("a login wall met by a read stops every later send", async () => {
    const { live, writes, showPage } = setup();
    const driver = live.driver();
    showPage(LOGIN_WALL);
    await expect(driver.viewProfile("someone")).rejects.toBeInstanceOf(LoggedOut);
    await expect(driver.sendInvite(person, "Hi", guard)).rejects.toBeInstanceOf(LoggedOut);
    expect(writes).toEqual([]);
  });

  it("an unexpected page does not latch: the next send goes ahead", async () => {
    const { live, writes, failWrite } = setup();
    const driver = live.driver();
    failWrite(new Unexpected("an odd dialog"));
    await expect(driver.sendInvite(person, "Hi", guard)).rejects.toBeInstanceOf(Unexpected);
    await expect(driver.sendInvite(person, "Hi", guard)).resolves.toBe("sent");
    expect(writes).toEqual(["invite someone Hi"]);
  });
});
