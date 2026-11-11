import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileInUse } from "../linkedin/browser";
import { FEED_URL } from "../linkedin/session";
import {
  createFakeSessionPort,
  createLiveSessionPort,
  parseFakeStates,
  SessionCheckFailed,
  type LiveWindow,
} from "./sessionPort";

const SIGNED_IN = '<html lang="en"><body><header id="global-nav"></header></body></html>';
const LOGIN = '<html lang="en"><body><form><input name="session_key"><input name="session_password"></form></body></html>';

interface StubPage {
  closed: boolean;
  html: string;
  readonly visited: string[];
  readonly screenshots: string[];
}

function stubWindow(page: StubPage): LiveWindow & { closedByApp: boolean } {
  const window = {
    closedByApp: false,
    page: {
      goto: async (url: string) => {
        page.visited.push(url);
      },
      waitForLoadState: async () => undefined,
      waitForSelector: async () => undefined,
      url: () => page.visited.at(-1) ?? "about:blank",
      content: async () => page.html,
      screenshot: async ({ path }: { path: string }) => {
        page.screenshots.push(path);
      },
      isClosed: () => page.closed,
    },
    close: async () => {
      window.closedByApp = true;
    },
  };
  return window;
}

function newPage(html: string): StubPage {
  return { closed: false, html, visited: [], screenshots: [] };
}

const noPace = async () => 0;

describe("createFakeSessionPort", () => {
  it("returns the scripted states in order and then keeps the last one", async () => {
    const port = createFakeSessionPort(["logged_out", "ok"]);

    const seen = [];
    for (let i = 0; i < 3; i += 1) seen.push((await port.check()).state);

    expect(seen).toEqual(["logged_out", "ok", "ok"]);
  });
});

describe("parseFakeStates", () => {
  it("reads a comma-separated list of session states", () => {
    expect(parseFakeStates("logged_out, ok,checkpoint")).toEqual(["logged_out", "ok", "checkpoint"]);
  });

  it("defaults to ok when nothing is set", () => {
    expect(parseFakeStates(undefined)).toEqual(["ok"]);
  });

  it("rejects a state the classifier cannot return", () => {
    expect(() => parseFakeStates("ok,banned")).toThrow(/banned/);
  });
});

describe("createLiveSessionPort", () => {
  it("opens no window until the first check", async () => {
    let opens = 0;
    createLiveSessionPort({
      open: async () => {
        opens += 1;
        return stubWindow(newPage(SIGNED_IN));
      },
      pace: noPace,
    });

    expect(opens).toBe(0);
  });

  it("loads the feed, classifies it and keeps the window for the next check", async () => {
    const page = newPage(SIGNED_IN);
    let opens = 0;
    const port = createLiveSessionPort({
      open: async () => {
        opens += 1;
        return stubWindow(page);
      },
      pace: noPace,
    });

    const first = await port.check();
    await port.check();

    expect(first.state).toBe("ok");
    expect(first.screenshotPath).toBeUndefined();
    expect(page.visited).toEqual([FEED_URL, FEED_URL]);
    expect(opens).toBe(1);
  });

  it("saves a screenshot when the session is not ok", async () => {
    const page = newPage(LOGIN);
    const screenshotsDir = mkdtempSync(join(tmpdir(), "lo-shots-"));
    const port = createLiveSessionPort({
      open: async () => stubWindow(page),
      pace: noPace,
      screenshotsDir,
      now: () => new Date("2026-11-11T09:00:00.000Z"),
    });

    const result = await port.check();

    expect(result.state).toBe("logged_out");
    expect(result.screenshotPath).toBe(join(screenshotsDir, "2026-11-11T09-00-00-000Z-session-logged_out.png"));
    expect(page.screenshots).toEqual([result.screenshotPath]);
  });

  it("opens the window again when the user has closed it", async () => {
    const pages = [newPage(SIGNED_IN), newPage(SIGNED_IN)];
    let opens = 0;
    const port = createLiveSessionPort({
      open: async () => {
        const page = pages[opens];
        opens += 1;
        if (page === undefined) throw new Error("opened too often");
        return stubWindow(page);
      },
      pace: noPace,
    });
    await port.check();
    const first = pages[0];
    if (first !== undefined) first.closed = true;

    await port.check();

    expect(opens).toBe(2);
  });

  it("reports a profile already in use as a clear failure", async () => {
    const port = createLiveSessionPort({
      open: async () => {
        throw new ProfileInUse("/data/chrome-profile", { host: "mac", pid: 42 });
      },
      pace: noPace,
    });

    const failure = await port.check().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionCheckFailed);
    expect(failure).toHaveProperty("message", expect.stringMatching(/already open \(Chrome process 42\)/));
  });

  it("reports a launch failure as a clear failure and tries again on the next check", async () => {
    let opens = 0;
    const port = createLiveSessionPort({
      open: async () => {
        opens += 1;
        if (opens === 1) throw new Error("browserType.launchPersistentContext: crashed");
        return stubWindow(newPage(SIGNED_IN));
      },
      pace: noPace,
    });

    const failure = await port.check().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionCheckFailed);
    expect(failure).toHaveProperty("message", "Could not open the dedicated Chrome window: browserType.launchPersistentContext: crashed");
    expect((await port.check()).state).toBe("ok");
  });

  it("closes the window it opened", async () => {
    const window = stubWindow(newPage(SIGNED_IN));
    const port = createLiveSessionPort({ open: async () => window, pace: noPace });
    await port.check();

    await port.close();

    expect(window.closedByApp).toBe(true);
  });

  it("closes without opening anything when no check ran", async () => {
    let opens = 0;
    const port = createLiveSessionPort({
      open: async () => {
        opens += 1;
        return stubWindow(newPage(SIGNED_IN));
      },
      pace: noPace,
    });

    await port.close();

    expect(opens).toBe(0);
  });
});
