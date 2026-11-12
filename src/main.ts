/**
 * `npm start`: the app in one process. Opens the database, serves the API and the dashboard on
 * 127.0.0.1, then runs the engine (the worker of spec section 3), checks the LinkedIn session once
 * if it is inside the working window, and opens the dashboard in the default browser. Beside the
 * engine it backs up the database at start and hourly, holds keep-awake while a campaign works
 * (`worker/operations.ts`), and writes start, stop, session changes, engine errors and backups to
 * `logs/app.log` (ids only, never a person's name or a message text).
 *
 * One process only (decision 54): the instance lock (`app.lock` in the data directory,
 * `worker/instanceLock.ts`) is taken before the database is opened, so a second app on the same
 * data, on any port, exits without touching it; the engine starts only once the port is bound; and
 * the dedicated window's profile lock is taken before any tick that may load LinkedIn (`runner.ts`).
 *
 * The fake LinkedIn (`LINKEDIN_DRIVER=fake`) never runs on the default data directory: pretend
 * sends must not reach the user's real data.
 *
 * Environment (`worker/env.ts`): `PORT` (default 4747), `LINKEDIN_DRIVER` (`live` default, or
 * `fake`), `ENGINE=off` to run without the engine, `FAKE_SESSION_STATES` and
 * `FAKE_SESSION_DELAY_MS` for the fake, `NO_OPEN=1` to skip opening the browser,
 * `LINKEDIN_OUTREACH_DATA_DIR`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createAi } from "./ai/index";
import { dataPaths } from "./config/paths";
import { getSettings } from "./config/settings";
import { ensureDataDir, openDb } from "./db/index";
import { systemClock } from "./engine/ports";
import { openDedicatedWindow } from "./linkedin/browser";
import { driverPageFor } from "./linkedin/driver";
import { navigationStateFile, paceNavigation } from "./linkedin/human";
import { backupIfDue, backupNow } from "./ops/backup";
import { activeCampaignCount, createKeepAwake, isKeepAwakeWanted } from "./ops/keepAwake";
import { createFileLogger } from "./ops/log";
import { defaultServiceContext, serviceStatus } from "./ops/service";
import { buildServer } from "./server/app";
import { createFakeSessionPort, parseFakeStates, type SessionPort } from "./server/sessionPort";
import { createSessionCheck, readSession, runStartupCheck } from "./server/sessionStore";
import { parseEnv, scratchDataDirProblem } from "./worker/env";
import { takeInstanceLock } from "./worker/instanceLock";
import { createFakeLinkedIn } from "./worker/fakeLinkedIn";
import { createLiveLinkedIn } from "./worker/liveDriver";
import { logSessionChanges, startOperations, type Operations } from "./worker/operations";
import { startRunner, type Runner, type RunnerDeps } from "./worker/runner";

const HOST = "127.0.0.1";
const UI_DIR = fileURLToPath(new URL("../dist/ui", import.meta.url));
const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));
/** Two driver page loads at least this far apart, from any process; the engine's own pacing adds more. */
const DRIVER_GAP_MS = { min: 10_000, max: 20_000 } as const;
/** How long shutdown waits for the tick in flight before closing the window anyway. */
const STOP_GRACE_MS = 120_000;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function complain(line: string): void {
  process.stderr.write(`${line}\n`);
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

async function main(): Promise<number> {
  const parsedEnv = parseEnv(process.env);
  if (!parsedEnv.success) {
    complain(`Bad environment: ${z.prettifyError(parsedEnv.error)}`);
    return 2;
  }
  const env = parsedEnv.data;

  if (env.LINKEDIN_DRIVER === "fake") {
    const problem = scratchDataDirProblem(process.env);
    if (problem !== null) {
      complain(
        `The fake LinkedIn does not run on your real data: ${problem}. Set LINKEDIN_OUTREACH_DATA_DIR to a scratch folder, for example LINKEDIN_OUTREACH_DATA_DIR="$(mktemp -d)" LINKEDIN_DRIVER=fake npm start.`,
      );
      return 2;
    }
  }

  const paths = dataPaths();
  ensureDataDir(paths);
  // Before the database is opened: a second app on this data directory must not touch it.
  const lock = takeInstanceLock(paths.root);
  if (lock.kind === "held") {
    const who = lock.pid === null ? "another process" : `process ${lock.pid}`;
    complain(
      `The app is already running on ${paths.root} (${who} holds ${lock.path}). Stop that one first. If no copy of the app is running, delete ${lock.path} and start again.`,
    );
    return 1;
  }
  process.on("exit", () => lock.release());
  const opened = openDb(paths.db);
  const log = createFileLogger({ dir: paths.logs });

  // What the engine and the session checks use for LinkedIn. Nothing here opens a window or loads a page.
  let port: SessionPort;
  let linkedin: Pick<RunnerDeps, "driver" | "outreach" | "ai" | "window">;
  if (env.LINKEDIN_DRIVER === "fake") {
    port = createFakeSessionPort(parseFakeStates(env.FAKE_SESSION_STATES), { delayMs: env.FAKE_SESSION_DELAY_MS });
    linkedin = createFakeLinkedIn({ clock: systemClock, random: Math.random, start: new Date() });
  } else {
    // Read-only on the live site in this build, on purpose and with no switch: `createLiveLinkedIn`
    // gives the engine `outreach: false` and a driver whose sends throw (see `readOnlyLinkedIn`).
    const live = createLiveLinkedIn({
      open: () => openDedicatedWindow(),
      pageFor: driverPageFor,
      pace: () => paceNavigation({ stateFile: navigationStateFile(), minGapMs: DRIVER_GAP_MS.min, maxGapMs: DRIVER_GAP_MS.max }),
      screenshotsDir: paths.screenshots,
    });
    port = live.sessionPort;
    linkedin = { driver: live.driver, outreach: live.outreach, window: live.window, ai: () => createAi(getSettings(opened.db).ai) };
  }

  const session = logSessionChanges(createSessionCheck({ db: opened.db, port }), {
    readStatus: () => readSession(opened.db).status,
    log,
  });
  // Started once the port is bound, below; the routes read keep-awake through it.
  let operations: Operations | null = null;
  const serviceContext = defaultServiceContext();
  const app = buildServer({
    db: opened.db,
    session,
    uiDir: UI_DIR,
    port: env.PORT,
    logger: { level: "warn" },
    screenshotsDir: paths.screenshots,
    ops: {
      paths,
      backupNow: () => backupNow(opened.sqlite, paths, new Date()),
      serviceStatus: () => serviceStatus(serviceContext),
      repoDir: REPO_DIR,
      keepAwakeActive: () => operations?.keepAwakeActive() ?? false,
      createAi: (settings) => createAi(settings),
      log,
    },
  });
  if (!existsSync(join(UI_DIR, "index.html"))) complain("The dashboard is not built yet: run `npm run build:ui`.");

  try {
    await app.listen({ host: HOST, port: env.PORT });
  } catch (error) {
    await app.close().catch(() => undefined);
    opened.close();
    if (isAddressInUse(error)) {
      complain(
        `Port ${env.PORT} is already in use: the app is probably running already (open http://localhost:${env.PORT}), or set PORT to use another port.`,
      );
      return 1;
    }
    throw error;
  }

  const url = `http://localhost:${env.PORT}`;
  say(`LinkedIn outreach is running at ${url} (LinkedIn driver: ${env.LINKEDIN_DRIVER}). Press Ctrl+C to stop.`);
  log.info("app started", { port: env.PORT, driver: env.LINKEDIN_DRIVER, engine: env.ENGINE, pid: process.pid });

  const ops = startOperations({
    engine: env.ENGINE,
    backupIfDue: () => backupIfDue(opened.sqlite, paths, new Date()),
    keepAwake: () =>
      createKeepAwake({
        spawn: (command, args, options) => spawn(command, [...args], options),
        onError: (message) => log.warn("keep-awake could not start caffeinate", { error: message }),
      }),
    keepAwakeWanted: () =>
      isKeepAwakeWanted({ settings: getSettings(opened.db), activeCampaigns: activeCampaignCount(opened.db), now: new Date() }),
    log,
  });
  operations = ops;

  // The port is bound: this is the only app on this machine, so the engine may run.
  let runner: Runner | null = null;
  if (env.ENGINE === "on") {
    runner = startRunner({ db: opened.db, clock: systemClock, random: Math.random, log, say, ...linkedin });
    say(env.LINKEDIN_DRIVER === "live" ? "Engine: running, read-only on LinkedIn (no sends in this build)." : "Engine: running on the fake LinkedIn.");
  } else {
    say("Engine: off (ENGINE=off).");
  }

  let stopping = false;
  const stop = async (): Promise<void> => {
    say("Stopping: waiting for the engine's current step to finish…");
    log.info("app stopping");
    // Timers and keep-awake first; a backup in flight is let finish before the database closes.
    await ops.stop();
    if (runner !== null) {
      const finished = await Promise.race([
        runner.stop().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), STOP_GRACE_MS).unref()),
      ]);
      if (!finished) {
        complain("The engine's step did not finish in time; it is checked again at the next start.");
        log.warn("engine step did not finish before shutdown");
      }
    }
    await session.close().catch((error: unknown) => complain(`Could not close the dedicated window: ${String(error)}`));
    await app.close().catch(() => undefined);
    opened.close();
    log.info("app stopped");
  };

  const stopped = new Promise<number>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        // A second Ctrl+C does not wait for the engine.
        if (stopping) {
          resolve(130);
          return;
        }
        stopping = true;
        void stop().then(
          () => resolve(0),
          (error: unknown) => {
            complain(`Could not stop cleanly: ${String(error)}`);
            log.error("app could not stop cleanly", { error: String(error) });
            resolve(1);
          },
        );
      });
    }
  });

  // One session check at start, only inside the working window on the live site. A failure is stored and logged; it never stops the app.
  void runStartupCheck({ db: opened.db, session, onlyInWorkingWindow: env.LINKEDIN_DRIVER === "live" }).then(
    (outcome) => {
      if (outcome.kind === "checked") say(`LinkedIn session: ${outcome.session.status}`);
      if (outcome.kind === "failed") complain(`LinkedIn session check failed: ${outcome.error}`);
      if (outcome.kind === "outside_working_window") {
        say(`Outside working hours: the LinkedIn session is not checked now (last known: ${outcome.session.status}).`);
      }
    },
    (error: unknown) => {
      if (!stopping) complain(`LinkedIn session check failed: ${String(error)}`);
    },
  );

  if (env.NO_OPEN !== "1") {
    const opener = spawn("open", [url], { stdio: "ignore", detached: true });
    opener.on("error", (error) => complain(`Could not open the browser (${error.message}); open ${url} yourself.`));
    opener.unref();
  }

  return stopped;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    complain(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
