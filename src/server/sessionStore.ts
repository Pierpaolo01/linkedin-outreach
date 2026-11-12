import { eq } from "drizzle-orm";
import { getSettings } from "../config/settings";
import type { Db } from "../db/index";
import { isInWorkingWindow } from "../engine/workingWindow";
import { eventLog, sessionState, type EventLevel, type SessionStatus } from "../db/schema";
import type { SessionCheckResult, SessionPort } from "./sessionPort";

/** The `session_state` row: the LinkedIn session as last observed. */
export interface StoredSession {
  readonly status: SessionStatus;
  /** When a check last observed the session; `null` if none has. */
  readonly lastCheckedAt: Date | null;
  /** Why the last check did not find ok: the classifier's evidence, or the error that stopped the check. */
  readonly lastError: string | null;
  readonly screenshotPath: string | null;
}

const SESSION_ROW = 1;

const NEVER_CHECKED: StoredSession = { status: "unknown", lastCheckedAt: null, lastError: null, screenshotPath: null };

/** A missing row reads as `unknown`, never checked. */
export function readSession(db: Db): StoredSession {
  const row = db.select().from(sessionState).where(eq(sessionState.id, SESSION_ROW)).get();
  if (row === undefined) return NEVER_CHECKED;
  return { status: row.status, lastCheckedAt: row.lastCheckedAt, lastError: row.lastError, screenshotPath: row.screenshotPath };
}

const LEVEL: Readonly<Record<SessionStatus, EventLevel>> = {
  ok: "info",
  unknown: "warning",
  logged_out: "warning",
  search_capped: "warning",
  checkpoint: "error",
  restricted: "error",
};

function writeSession(db: Db, next: StoredSession, at: Date, failure?: string): StoredSession {
  db.transaction((tx) => {
    const previous = tx.select({ status: sessionState.status }).from(sessionState).where(eq(sessionState.id, SESSION_ROW)).get();
    const previousStatus = previous?.status ?? NEVER_CHECKED.status;
    tx.insert(sessionState)
      .values({ id: SESSION_ROW, ...next })
      .onConflictDoUpdate({ target: sessionState.id, set: next })
      .run();
    if (next.status !== previousStatus) {
      tx.insert(eventLog).values({ at, level: LEVEL[next.status], message: `LinkedIn session: ${next.status}` }).run();
    }
    if (failure !== undefined) {
      tx.insert(eventLog).values({ at, level: "warning", message: `LinkedIn session check failed: ${failure}` }).run();
    }
  });
  return next;
}

/** Stores what a check observed. The classifier's `unknown` is stored as status `unknown`. */
export function recordCheck(db: Db, result: SessionCheckResult, at: Date): StoredSession {
  return writeSession(
    db,
    {
      status: result.state,
      lastCheckedAt: at,
      lastError: result.state === "ok" ? null : result.evidence,
      screenshotPath: result.screenshotPath ?? null,
    },
    at,
  );
}

/** Stores a check that could not look at LinkedIn. The last observed status stands: nothing new was seen. */
export function recordFailure(db: Db, message: string, at: Date): StoredSession {
  return writeSession(db, { ...readSession(db), lastError: message }, at, message);
}

export type SessionCheckOutcome =
  | { readonly kind: "checked"; readonly session: StoredSession }
  | { readonly kind: "failed"; readonly session: StoredSession; readonly error: string }
  | { readonly kind: "busy" };

export interface SessionCheck {
  /** Runs one check through the port and stores the result, failures included. Refuses while another check runs. Throws only when the database cannot be written. */
  run(): Promise<SessionCheckOutcome>;
  readonly running: boolean;
  /** Closes the port (and with it the dedicated window). */
  close(): Promise<void>;
}

/** The one place session checks start, so the API and the startup check share the one-at-a-time rule. */
export function createSessionCheck({
  db,
  port,
  now = () => new Date(),
}: {
  db: Db;
  port: SessionPort;
  now?: () => Date;
}): SessionCheck {
  let running = false;
  return {
    async run() {
      if (running) return { kind: "busy" };
      running = true;
      try {
        let result: SessionCheckResult;
        try {
          result = await port.check();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { kind: "failed", session: recordFailure(db, message, now()), error: message };
        }
        return { kind: "checked", session: recordCheck(db, result, now()) };
      } finally {
        running = false;
      }
    },
    get running() {
      return running;
    },
    close: () => port.close(),
  };
}

export type StartupCheckOutcome = SessionCheckOutcome | { readonly kind: "outside_working_window"; readonly session: StoredSession };

/**
 * The check `npm start` runs once. With `onlyInWorkingWindow` (the live site) it runs only inside
 * the working window from the settings; outside it no LinkedIn page is loaded and the stored state
 * stands. The user's own Re-check is not held by the window: that is his deliberate action.
 */
export async function runStartupCheck({
  db,
  session,
  now = () => new Date(),
  onlyInWorkingWindow,
}: {
  db: Db;
  session: SessionCheck;
  now?: () => Date;
  onlyInWorkingWindow: boolean;
}): Promise<StartupCheckOutcome> {
  if (onlyInWorkingWindow && !isInWorkingWindow(getSettings(db), now())) {
    return { kind: "outside_working_window", session: readSession(db) };
  }
  return session.run();
}
