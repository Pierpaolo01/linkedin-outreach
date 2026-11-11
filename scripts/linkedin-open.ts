/**
 * `npm run linkedin:open [-- --until-ok]`
 *
 * Opens the dedicated window so the user can log in to LinkedIn himself, then
 * watches the session without navigating, typing or clicking: it classifies
 * whatever page the window shows and prints a line when the state changes.
 *
 * Exits 0 when the user closes the window, or with `--until-ok` as soon as the
 * session is ok (closing the window, so nothing is left running).
 */
import type { Page } from "playwright";
import { openDedicatedWindow, ProfileInUse, type DedicatedWindow } from "../src/linkedin/browser";
import { navigationStateFile, realSleep, recordNavigation } from "../src/linkedin/human";
import { classifyPage, FEED_URL, settle, type PageClassification, type SessionState } from "../src/linkedin/session";

const LOGIN_URL = "https://www.linkedin.com/login";
const POLL_MS = 2_000;

async function main(): Promise<number> {
  const untilOk = process.argv.includes("--until-ok");

  let window: DedicatedWindow;
  try {
    window = await openDedicatedWindow();
  } catch (error) {
    if (error instanceof ProfileInUse) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  let closed = false;
  window.context.on("close", () => {
    closed = true;
  });
  const shutdown = (code: number) => {
    void window.close().finally(() => process.exit(code));
  };
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));

  // Only the name of LinkedIn's session cookie is checked, never its value.
  const cookies = await window.context.cookies("https://www.linkedin.com");
  const hasSessionCookie = cookies.some((cookie) => cookie.name === "li_at");
  recordNavigation({ stateFile: navigationStateFile(), at: Date.now() });
  await window.page.goto(hasSessionCookie ? FEED_URL : LOGIN_URL, { waitUntil: "domcontentloaded" });
  await settle(window.page);

  let printed: SessionState | undefined;
  let candidate: SessionState | undefined;
  while (!closed) {
    const page = currentPage(window);
    if (page === undefined) break; // the user closed the window
    const seen = await observe(page);
    const state = seen?.state;
    // Print a state once it holds for two polls in a row, so a page mid-navigation does not flicker.
    if (seen !== undefined && state === candidate && state !== printed) {
      console.log(`session: ${seen.state} (${seen.evidence})`);
      printed = state;
      if (untilOk && state === "ok") break;
    }
    candidate = state;
    await realSleep(POLL_MS);
  }

  await window.close().catch(() => undefined);
  return 0;
}

/** The tab to watch: the most recently opened one still open. */
function currentPage(window: DedicatedWindow): Page | undefined {
  return window.context.pages().filter((page) => !page.isClosed()).at(-1);
}

/** Classifies the page as it is; `undefined` while it is navigating or closing. */
async function observe(page: Page): Promise<PageClassification | undefined> {
  try {
    return classifyPage({ url: page.url(), html: await page.content() });
  } catch {
    return undefined;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
