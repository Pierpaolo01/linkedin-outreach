import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * `npm start`'s environment. There is deliberately no variable that turns sends on: on the live
 * site the engine is read-only in this build (`readOnlyLinkedIn`).
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4747),
  /** `live` (default): the dedicated window. `fake`: a simulated LinkedIn where everything, sends included, is pretend. */
  LINKEDIN_DRIVER: z.enum(["live", "fake"]).default("live"),
  /** `off` starts the app without the engine (browser tests, so seeded numbers do not move). */
  ENGINE: z.enum(["on", "off"]).default("on"),
  FAKE_SESSION_STATES: z.string().optional(),
  FAKE_SESSION_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
  NO_OPEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(env: Readonly<Record<string, string | undefined>>) {
  return envSchema.safeParse(env);
}

/** The data directory the app uses when LINKEDIN_OUTREACH_DATA_DIR is not set (the default of `dataPaths()`). */
export function defaultDataDir(): string {
  return join(homedir(), "Library", "Application Support", "linkedin-outreach");
}

/** A folder as the file system knows it (links followed when it exists), in lower case: macOS folders ignore case. */
function sameFolderKey(path: string): string {
  const full = resolve(path);
  let real = full;
  try {
    real = realpathSync(full);
  } catch {
    // Not there yet: compared as written.
  }
  return real.toLowerCase();
}

/**
 * Why `env` does not name a scratch data directory, or null when it does: LINKEDIN_OUTREACH_DATA_DIR
 * must be set and must not be the default data directory. Whatever writes pretend data (the fake
 * LinkedIn, the demo seed) checks it first, so pretend data never reaches the user's real data.
 */
export function scratchDataDirProblem(env: Readonly<Record<string, string | undefined>>): string | null {
  const chosen = env["LINKEDIN_OUTREACH_DATA_DIR"];
  const real = defaultDataDir();
  if (chosen === undefined || chosen.trim() === "") return `LINKEDIN_OUTREACH_DATA_DIR is not set, so the real data directory (${real}) would be used`;
  if (sameFolderKey(chosen) === sameFolderKey(real) || resolve(chosen).toLowerCase() === resolve(real).toLowerCase()) {
    return `LINKEDIN_OUTREACH_DATA_DIR is the real data directory (${real})`;
  }
  return null;
}
