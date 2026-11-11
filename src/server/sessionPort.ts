import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataPaths } from "../config/paths";
import { openDedicatedWindow, ProfileInUse } from "../linkedin/browser";
import { navigationStateFile, paceNavigation } from "../linkedin/human";
import { ensureSession, type SessionPage, type SessionState } from "../linkedin/session";

/**
 * The seam between the app and LinkedIn for milestone 1: the one thing the
 * app asks of LinkedIn is "what state is the session in?". The real driver
 * interface replaces it in milestone 2.
 */
export interface SessionCheckResult {
  readonly state: SessionState;
  /** What the classifier matched, for logs and the banner. */
  readonly evidence: string;
  readonly screenshotPath?: string;
}

export interface SessionPort {
  check(): Promise<SessionCheckResult>;
  close(): Promise<void>;
}

/** A check that could not look at LinkedIn at all (window would not open, page would not load). */
export class SessionCheckFailed extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionCheckFailed";
  }
}

const SESSION_STATES = ["ok", "logged_out", "checkpoint", "restricted", "unknown"] as const satisfies readonly SessionState[];
const fakeStates = z.array(z.enum(SESSION_STATES)).min(1);

/** Reads `FAKE_SESSION_STATES`, for example `logged_out,ok`. Defaults to `ok`. */
export function parseFakeStates(raw: string | undefined): [SessionState, ...SessionState[]] {
  if (raw === undefined || raw.trim() === "") return ["ok"];
  const parsed = fakeStates.safeParse(raw.split(",").map((part) => part.trim()));
  if (!parsed.success) {
    throw new Error(`FAKE_SESSION_STATES must list session states (${SESSION_STATES.join(", ")}), got "${raw}"`);
  }
  const [first, ...rest] = parsed.data;
  if (first === undefined) throw new Error("FAKE_SESSION_STATES is empty");
  return [first, ...rest];
}

/** Returns the scripted states one per check, then keeps returning the last. Never touches LinkedIn. */
export function createFakeSessionPort(
  states: readonly [SessionState, ...SessionState[]],
  { delayMs = 0 }: { delayMs?: number } = {},
): SessionPort {
  let next = 0;
  return {
    async check() {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const state = states[Math.min(next, states.length - 1)] ?? states[0];
      next += 1;
      return { state, evidence: `fake driver: ${state}` };
    },
    close: async () => undefined,
  };
}

/** The slice of the dedicated window the live port uses. */
export interface LiveWindow {
  readonly page: SessionPage & {
    screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
    isClosed(): boolean;
  };
  close(): Promise<void>;
}

export interface LiveOptions {
  readonly open?: () => Promise<LiveWindow>;
  /** Waits for the shared gap between LinkedIn navigations. Returns how long it waited. */
  readonly pace?: () => Promise<number>;
  readonly screenshotsDir?: string;
  readonly now?: () => Date;
}

/** Two feed loads at least this far apart, from any process (shared with the capture tool). */
const CHECK_GAP_MS = { min: 10_000, max: 20_000 } as const;

/**
 * Checks the session in the dedicated window. Opens the window on the first
 * check only, keeps it open for later checks, and opens it again if the user
 * has closed it.
 */
export function createLiveSessionPort({
  open = openDedicatedWindow,
  pace = () => paceNavigation({ stateFile: navigationStateFile(), minGapMs: CHECK_GAP_MS.min, maxGapMs: CHECK_GAP_MS.max }),
  screenshotsDir = dataPaths().screenshots,
  now = () => new Date(),
}: LiveOptions = {}): SessionPort {
  let window: LiveWindow | undefined;

  async function currentWindow(): Promise<LiveWindow> {
    if (window !== undefined && !window.page.isClosed()) return window;
    if (window !== undefined) await window.close().catch(() => undefined);
    window = undefined;
    try {
      window = await open();
    } catch (error) {
      if (error instanceof ProfileInUse) throw new SessionCheckFailed(error.message, { cause: error });
      throw new SessionCheckFailed(`Could not open the dedicated Chrome window: ${messageOf(error)}`, { cause: error });
    }
    return window;
  }

  return {
    async check() {
      const { page } = await currentWindow();
      await pace();
      let result;
      try {
        result = await ensureSession(page);
      } catch (error) {
        throw new SessionCheckFailed(`Could not load LinkedIn in the dedicated window: ${messageOf(error)}`, { cause: error });
      }
      if (result.state === "ok") return result;
      const screenshotPath = await saveScreenshot(page, result.state);
      return screenshotPath === undefined ? result : { ...result, screenshotPath };
    },
    async close() {
      const open = window;
      window = undefined;
      await open?.close();
    },
  };

  async function saveScreenshot(page: LiveWindow["page"], state: SessionState): Promise<string | undefined> {
    const path = join(screenshotsDir, `${now().toISOString().replace(/[:.]/g, "-")}-session-${state}.png`);
    try {
      mkdirSync(screenshotsDir, { recursive: true });
      await page.screenshot({ path, fullPage: true });
      return path;
    } catch {
      return undefined;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
