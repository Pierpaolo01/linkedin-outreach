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
 */
import type { WriteDriver } from "../driver";
import { LinkedInError } from "../errors";
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
      if (error instanceof LinkedInError && SAFETY_STOPS.has(error.kind)) stopped = error;
      throw error;
    }
  }

  return {
    sendInvite: (person, note, guard) => latched(() => sendInvite(deps, person, note, guard)),
    sendMessage: (person, text, expected) => latched(() => sendMessage(deps, person, text, expected)),
    withdrawInvite: (person, guard) => latched(() => withdrawInvite(deps, person, guard)),
  };
}
