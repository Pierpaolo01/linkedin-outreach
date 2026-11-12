/**
 * The operations `npm start` runs beside the engine (spec section 11): today's backup at start and
 * then hourly, and keep-awake checked every minute. Nothing here stops the app: a failure is
 * written to the app's log and tried again at the next timer.
 *
 * With the engine off (`ENGINE=off`, the browser tests) there is no keep-awake, so no `caffeinate`
 * child; backups still run, being local and quick.
 */
import { basename } from "node:path";
import type { BackupOutcome } from "../ops/backup";
import type { KeepAwake } from "../ops/keepAwake";
import type { Logger } from "../ops/log";
import type { SessionCheck } from "../server/sessionStore";
import type { StoredSession } from "../server/sessionStore";
import type { Env } from "./env";

export const BACKUP_EVERY_MS = 60 * 60_000;
export const KEEP_AWAKE_EVERY_MS = 60_000;

/** Repeating timers; `every` returns what cancels its timer. */
export interface Timers {
  every(ms: number, run: () => void): () => void;
}

export const systemTimers: Timers = {
  every(ms, run) {
    const timer = setInterval(run, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};

export interface OperationsDeps {
  readonly engine: Env["ENGINE"];
  /** Today's backup unless it exists (`backupIfDue` on the open database). */
  readonly backupIfDue: () => Promise<BackupOutcome>;
  /** Builds the keep-awake (`createKeepAwake`). Not called with the engine off. */
  readonly keepAwake: () => KeepAwake;
  /** The per-minute decision (`isKeepAwakeWanted` with the stored settings). */
  readonly keepAwakeWanted: () => boolean;
  readonly log: Logger;
  readonly timers?: Timers;
}

export interface Operations {
  /** True while the app holds `caffeinate`. */
  keepAwakeActive(): boolean;
  /** Clears the timers, releases keep-awake, and resolves once a backup in flight has finished. */
  stop(): Promise<void>;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

export function startOperations(deps: OperationsDeps): Operations {
  const { log } = deps;
  const timers = deps.timers ?? systemTimers;

  let backupInFlight: Promise<void> | null = null;
  function backup(): void {
    if (backupInFlight !== null) return;
    const run = (async () => {
      let outcome: BackupOutcome;
      try {
        outcome = await deps.backupIfDue();
      } catch (error) {
        outcome = { kind: "failed", error: messageOf(error) };
      }
      if (outcome.kind === "created") log.info("backup created", { file: basename(outcome.file), bytes: outcome.bytes });
      if (outcome.kind === "failed") log.error("backup failed", { error: outcome.error });
    })();
    backupInFlight = run;
    void run.finally(() => {
      if (backupInFlight === run) backupInFlight = null;
    });
  }

  const keepAwake = deps.engine === "on" ? deps.keepAwake() : null;
  let wanted: boolean | null = null;
  function updateKeepAwake(): void {
    if (keepAwake === null) return;
    let now: boolean;
    try {
      now = deps.keepAwakeWanted();
    } catch (error) {
      log.error("keep-awake check failed", { error: messageOf(error) });
      return;
    }
    if (now !== wanted) log.info("keep-awake", { wanted: now });
    wanted = now;
    keepAwake.update({ wanted: now });
  }

  backup();
  updateKeepAwake();
  const cancels = [timers.every(BACKUP_EVERY_MS, backup), timers.every(KEEP_AWAKE_EVERY_MS, updateKeepAwake)];

  return {
    keepAwakeActive: () => keepAwake?.holding() ?? false,
    async stop() {
      for (const cancel of cancels) cancel();
      keepAwake?.stop();
      await backupInFlight;
    },
  };
}

/**
 * The session check with every change of state and every failed check written to the app's log.
 * The startup check, the dashboard's Re-check and nothing else run through it.
 */
export function logSessionChanges(
  check: SessionCheck,
  { readStatus, log }: { readonly readStatus: () => StoredSession["status"]; readonly log: Logger },
): SessionCheck {
  return {
    async run() {
      const before = readStatus();
      const outcome = await check.run();
      if (outcome.kind === "busy") return outcome;
      if (outcome.session.status !== before) log.info("session changed", { from: before, to: outcome.session.status });
      if (outcome.kind === "failed") log.warn("session check failed", { error: outcome.error });
      return outcome;
    },
    get running() {
      return check.running;
    },
    close: () => check.close(),
  };
}
