/**
 * The worker of spec section 3: runs the engine inside `npm start`. It owns the tick loop and is
 * the only thing that calls `engine.tick()`, one tick at a time (decision 58). Before each tick it
 * builds a new engine when the AI in Settings is not the one the current engine was built with.
 *
 * After each tick it waits until the engine's `wakeAt`, but never more than 30 s, so a change made
 * in the dashboard (a campaign started, a prospect approved, a limit changed) is picked up within
 * half a minute. A tick that rejects is written to the event log and to the app's log (`logs/app.log`),
 * and the runner tries again a minute later; it never exits on its own.
 */
import type { Ai } from "../ai/types";
import { getSettings } from "../config/settings";
import type { Db } from "../db/index";
import { createEngine, pickDueWork } from "../engine/engine";
import { logEvent } from "../engine/ledger";
import type { Clock, Driver, Engine, EngineDeps, RandomSource } from "../engine/ports";
import { activeSafetyStop } from "../engine/safetyStop";
import { isInWorkingWindow } from "../engine/workingWindow";
import type { Logger } from "../ops/log";
import { recordFailure } from "../server/sessionStore";

/** The longest wait between two ticks. */
export const MAX_WAIT_MS = 30_000;
/** The wait after a tick that rejected, or after the dedicated window could not be taken. */
export const AFTER_ERROR_MS = 60_000;

export interface RunnerDeps {
  readonly db: Db;
  /** The engine's clock; the runner reads the time from it too. */
  readonly clock: Clock;
  readonly random: RandomSource;
  /** The app's file log; a tick that rejects is written to it. */
  readonly log: Logger;
  /** Builds the driver for a new engine: at start and after every resumed safety stop. */
  readonly driver: () => Driver;
  /** Passed to the engine: false picks no invite, message, follow-up or withdrawal. */
  readonly outreach: boolean;
  /** The AI for a new engine, read at each build. A throw means the engine runs without AI work. */
  readonly ai: () => Ai;
  /**
   * Takes the dedicated window, opening it if it is not open. Called before a tick that may load
   * LinkedIn, never at start. A throw (`ProfileInUse`: another process owns the window) means that
   * tick does not run. Absent when there is no window (the fake LinkedIn).
   */
  readonly window?: () => Promise<void>;
  /** Waits `ms`, or less when `signal` aborts. Default: a timer. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Default `createEngine`; tests pass a stub. */
  readonly engine?: (deps: EngineDeps) => Engine;
  /** One line for the terminal. Default: nothing. */
  readonly say?: (line: string) => void;
}

export interface Runner {
  /** Ends the loop. Resolves once the tick in flight, if any, has finished. */
  stop(): Promise<void>;
}

/** Waits `ms` with a timer, ending early (without error) when `signal` aborts. */
export function timerWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim();
}

/** Starts the loop at once and returns its handle. */
export function startRunner(deps: RunnerDeps): Runner {
  const { db, clock } = deps;
  const wait = deps.wait ?? timerWait;
  const say = deps.say ?? (() => undefined);
  const makeEngine = deps.engine ?? createEngine;
  const stopping = new AbortController();

  /** One line to the event log; a database that cannot be written must not end the loop. */
  function note(level: "info" | "warning" | "error", message: string): void {
    try {
      logEvent(db, { level, message }, clock.now());
    } catch (error) {
      say(`Could not write the event log: ${messageOf(error)}`);
    }
  }

  interface Built {
    readonly engine: Engine;
    readonly withAi: boolean;
    /** `settings.ai` as it was when this engine was built. */
    readonly aiSettings: string;
  }

  /** The AI setting, in a form two readings can be compared by. */
  const aiSettingsNow = (): string => JSON.stringify(getSettings(db).ai);

  function build(): Built {
    const aiSettings = aiSettingsNow();
    let ai: Ai | undefined;
    try {
      ai = deps.ai();
    } catch (error) {
      const line = `The AI could not be set up (${messageOf(error)}); the engine runs without AI work`;
      say(line);
      note("warning", line);
    }
    const engine = makeEngine({
      db,
      driver: deps.driver(),
      clock,
      random: deps.random,
      outreach: deps.outreach,
      ...(ai === undefined ? {} : { ai }),
    });
    return { engine, withAi: ai !== undefined, aiSettings };
  }

  /** True when the next tick may load LinkedIn: no safety stop, inside the working window, and LinkedIn work is due. */
  function mayLoadLinkedIn(withAi: boolean): boolean {
    const now = clock.now();
    if (activeSafetyStop(db) !== null) return false;
    const settings = getSettings(db);
    if (!isInWorkingWindow(settings, now)) return false;
    return pickDueWork(db, settings, now, { outreach: deps.outreach, discovery: withAi }) !== null;
  }

  /** Takes the window when the tick may need it. False: the tick must not run. */
  let windowRefused = false;
  async function windowReady(withAi: boolean): Promise<boolean> {
    if (deps.window === undefined || !mayLoadLinkedIn(withAi)) return true;
    try {
      await deps.window();
    } catch (error) {
      if (!windowRefused) {
        windowRefused = true;
        const line = `The engine could not take the dedicated window, so it does not work on LinkedIn: ${messageOf(error)}`;
        say(line);
        try {
          recordFailure(db, line, clock.now());
        } catch (dbError) {
          say(`Could not store the session state: ${messageOf(dbError)}`);
        }
      }
      return false;
    }
    if (windowRefused) {
      windowRefused = false;
      say("The engine has the dedicated window again");
      note("info", "The engine has the dedicated window again and carries on");
    }
    return true;
  }

  async function loop(): Promise<void> {
    let built: Built | null = null;
    let stopWasActive = false;
    while (!stopping.signal.aborted) {
      let pause: number;
      try {
        // A driver latches on a safety error (decision 18): after the user's Resume, start afresh (decision 43).
        const stopIsActive = activeSafetyStop(db) !== null;
        if (built !== null && stopWasActive && !stopIsActive) {
          say("Safety stop resumed: the engine starts again with a new LinkedIn driver");
          built = null;
        }
        stopWasActive = stopIsActive;
        // The engine holds the AI it was built with: a change in Settings needs a new one.
        if (built !== null && aiSettingsNow() !== built.aiSettings) {
          say("The AI setting changed: the engine starts again with the new AI");
          note("info", "The AI setting changed: the engine starts again with the new AI");
          built = null;
        }
        built ??= build();

        if (await windowReady(built.withAi)) {
          const result = await built.engine.tick();
          // Only the kind of work ("invite", "scoring"): what follows the colon can name a person.
          if (result.did !== null) say(`Engine: ${result.did.split(":")[0] ?? "work"}`);
          pause = Math.min(MAX_WAIT_MS, Math.max(0, result.wakeAt.getTime() - clock.now().getTime()));
        } else {
          pause = AFTER_ERROR_MS;
        }
      } catch (error) {
        const message = messageOf(error);
        deps.log.error("engine tick failed", { error: message });
        note("error", `The engine's tick failed (${message}); it tries again in a minute`);
        pause = AFTER_ERROR_MS;
      }
      if (stopping.signal.aborted) break;
      // A wakeAt already passed still lets the server's requests in before the next tick.
      if (pause > 0) await wait(pause, stopping.signal);
      else await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  const finished = loop().catch((error: unknown) => {
    // Every step of the loop catches its own errors; this is only a last resort.
    say(`The engine stopped: ${messageOf(error)}`);
  });

  return {
    async stop() {
      stopping.abort();
      await finished;
    },
  };
}
