/**
 * `npm start`: the app in one process. Opens the database, serves the API and
 * the dashboard on 127.0.0.1, checks the LinkedIn session once in the
 * background and opens the dashboard in the default browser.
 *
 * Environment: `PORT` (default 4747), `LINKEDIN_DRIVER` (`live` default, or
 * `fake`), `FAKE_SESSION_STATES` and `FAKE_SESSION_DELAY_MS` for the fake,
 * `NO_OPEN=1` to skip opening the browser, `LINKEDIN_OUTREACH_DATA_DIR`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { dataPaths } from "./config/paths";
import { ensureDataDir, openDb } from "./db/index";
import { buildServer } from "./server/app";
import { createFakeSessionPort, createLiveSessionPort, parseFakeStates, type SessionPort } from "./server/sessionPort";
import { createSessionCheck } from "./server/sessionStore";

const HOST = "127.0.0.1";
const UI_DIR = fileURLToPath(new URL("../dist/ui", import.meta.url));

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4747),
  LINKEDIN_DRIVER: z.enum(["live", "fake"]).default("live"),
  FAKE_SESSION_STATES: z.string().optional(),
  FAKE_SESSION_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
  NO_OPEN: z.string().optional(),
});

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
  const parsedEnv = envSchema.safeParse(process.env);
  if (!parsedEnv.success) {
    complain(`Bad environment: ${z.prettifyError(parsedEnv.error)}`);
    return 2;
  }
  const env = parsedEnv.data;

  const port: SessionPort =
    env.LINKEDIN_DRIVER === "fake"
      ? createFakeSessionPort(parseFakeStates(env.FAKE_SESSION_STATES), { delayMs: env.FAKE_SESSION_DELAY_MS })
      : createLiveSessionPort();

  const paths = dataPaths();
  ensureDataDir(paths);
  const opened = openDb(paths.db);
  const session = createSessionCheck({ db: opened.db, port });
  const app = buildServer({ db: opened.db, session, uiDir: UI_DIR, port: env.PORT, logger: { level: "warn" } });
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

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await session.close().catch((error: unknown) => complain(`Could not close the dedicated window: ${String(error)}`));
    await app.close().catch(() => undefined);
    opened.close();
  };

  const stopped = new Promise<number>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => void stop().then(() => resolve(0)));
    }
  });

  // One session check right after start. A failure is stored and logged; it never stops the app.
  void session.run().then(
    (outcome) => {
      if (outcome.kind === "checked") say(`LinkedIn session: ${outcome.session.status}`);
      if (outcome.kind === "failed") complain(`LinkedIn session check failed: ${outcome.error}`);
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
