/**
 * NOT VERIFIED ON THE LIVE SITE, and NOT WIRED INTO THE APP: the worker (`src/worker/liveDriver.ts`)
 * keeps its read-only wrapper, whose write operations throw. Nothing may be sent until the user
 * has created a campaign with his own text and approved its prospects, and the checklist in
 * docs/research/write-operations.md has been gone through on the live site.
 *
 * The write half of the live driver (`WriteDriver` in `../driver.ts`): `sendInvite`, `sendMessage`
 * and `withdrawInvite` over one `WritePage`, with the same latch as the read half: a login wall,
 * checkpoint, restriction or LinkedIn's invitation limit stops every later write without touching
 * LinkedIn again. Whoever joins the two halves into one `Driver` should share one latch.
 *
 * A page action that fails with an error of its own (Playwright's `Error` or `TimeoutError`) can be
 * LinkedIn swapping the page mid-action, so the page is classified as it is then: a login wall,
 * checkpoint or restriction becomes its typed error and sets the latch.
 */
import type { WriteDriver } from "../driver";
import { LinkedInError } from "../errors";
import { assertHealthy, savePage } from "../pageHealth";
import type { WriteDeps } from "./common";
import { sendInvite } from "./invite";
import { sendMessage } from "./message";
import { withdrawInvite } from "./withdraw";

const SAFETY_STOPS: ReadonlySet<LinkedInError["kind"]> = new Set(["logged_out", "checkpoint", "restricted", "limit_hit"]);

/** NOT VERIFIED ON THE LIVE SITE. */
export function createWriteDriver(deps: WriteDeps): WriteDriver {
  let stopped: LinkedInError | undefined;

  async function latched<T>(act: () => Promise<T>): Promise<T> {
    if (stopped !== undefined) throw stopped;
    try {
      return await act();
    } catch (error) {
      const typed = error instanceof LinkedInError ? error : await classifyAfter(error);
      if (SAFETY_STOPS.has(typed.kind)) stopped = typed;
      throw typed;
    }
  }

  /**
   * After an error that is not one of LinkedIn's: the typed error of a login wall, checkpoint or
   * restriction shown now (page saved by the health check); else the page is saved and the error
   * itself is thrown, a result not known. Not verified on the live site.
   */
  async function classifyAfter(error: unknown): Promise<LinkedInError> {
    const health = deps.health ?? {};
    try {
      await assertHealthy(deps.page, health);
    } catch (shown) {
      if (shown instanceof LinkedInError && SAFETY_STOPS.has(shown.kind)) return shown;
      throw error;
    }
    try {
      await savePage(deps.page, await deps.page.content(), "unknown", health);
    } catch {
      // The page could not be saved (the window closed): the error itself still goes up.
    }
    throw error;
  }

  return {
    sendInvite: (person, note, guard) => latched(() => sendInvite(deps, person, note, guard)),
    sendMessage: (person, text, expected) => latched(() => sendMessage(deps, person, text, expected)),
    withdrawInvite: (person, guard) => latched(() => withdrawInvite(deps, person, guard)),
  };
}
