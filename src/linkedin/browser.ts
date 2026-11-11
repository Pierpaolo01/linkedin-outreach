import { mkdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { dataPaths } from "../config/paths";

/**
 * The dedicated window: a visible, plain Google Chrome with its own persistent
 * profile in the data directory, where the user logs in to LinkedIn himself.
 * No stealth plugins, no user-agent changes, no extra launch flags.
 */
export interface DedicatedWindow {
  readonly context: BrowserContext;
  readonly page: Page;
  /** `chrome` is installed Google Chrome; `chromium` is Playwright's bundled fallback. */
  readonly browser: "chrome" | "chromium";
  close(): Promise<void>;
}

export interface OpenOptions {
  readonly profileDir?: string;
  /** Where to report which browser was used. Defaults to stderr. */
  readonly log?: (line: string) => void;
}

/** Another process already has the dedicated window's profile open. */
export class ProfileInUse extends Error {
  constructor(
    readonly profileDir: string,
    readonly holder: ProfileLockHolder | undefined,
  ) {
    super(
      `The dedicated window is already open${holder === undefined ? "" : ` (Chrome process ${holder.pid})`}. ` +
        `Only one process may use the profile at ${profileDir}. Close that window or stop the app, then try again.`,
    );
    this.name = "ProfileInUse";
  }
}

export interface ProfileLockHolder {
  readonly host: string;
  readonly pid: number;
}

/**
 * Chrome marks a profile in use with a `SingletonLock` symlink whose target is
 * `<hostname>-<pid>`. Returns the holder when that process is still alive.
 */
export function profileLockHolder(profileDir: string): ProfileLockHolder | undefined {
  let target: string;
  try {
    target = readlinkSync(join(profileDir, "SingletonLock"));
  } catch {
    return undefined;
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const pid = Number(match[2]);
  return isAlive(pid) ? { host: match[1], pid } : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Playwright's error when `channel: "chrome"` is asked for and Google Chrome is not installed. */
export function isChromeMissing(error: unknown): boolean {
  return error instanceof Error && /distribution 'chrome' is not found/i.test(error.message);
}

const launchOptions = { headless: false, viewport: null } as const;

export async function openDedicatedWindow(options: OpenOptions = {}): Promise<DedicatedWindow> {
  const profileDir = options.profileDir ?? dataPaths().chromeProfile;
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));

  const holder = profileLockHolder(profileDir);
  if (holder !== undefined) throw new ProfileInUse(profileDir, holder);
  // 0700 also for the data directory itself when this runs before `npm run setup`.
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  let context: BrowserContext;
  let browser: DedicatedWindow["browser"];
  try {
    context = await chromium.launchPersistentContext(profileDir, { ...launchOptions, channel: "chrome" });
    browser = "chrome";
    log(`dedicated window: Google Chrome, profile ${profileDir}`);
  } catch (error) {
    if (!isChromeMissing(error)) throw launchFailure(error, profileDir);
    log("dedicated window: Google Chrome is not installed, using Playwright's Chromium");
    try {
      context = await chromium.launchPersistentContext(profileDir, launchOptions);
      browser = "chromium";
    } catch (fallbackError) {
      throw launchFailure(fallbackError, profileDir);
    }
  }

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, browser, close: () => context.close() };
}

/** A launch that lost a race for the profile reads as a generic crash; report it as the lock it is. */
function launchFailure(error: unknown, profileDir: string): unknown {
  const holder = profileLockHolder(profileDir);
  if (holder !== undefined) return new ProfileInUse(profileDir, holder);
  if (error instanceof Error && /ProcessSingleton|SingletonLock|existing browser session/i.test(error.message)) {
    return new ProfileInUse(profileDir, undefined);
  }
  return error;
}
