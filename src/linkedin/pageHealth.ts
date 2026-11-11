import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataPaths } from "../config/paths";
import {
  Checkpoint,
  LoggedOut,
  Restricted,
  Unexpected,
  type LinkedInError,
  type LinkedInErrorOptions,
  type PageArtifacts,
} from "./errors";
import { classifyPage, type PageClassification, type SessionState } from "./session";

/** The slice of a Playwright `Page` the health check uses. */
export interface InspectablePage {
  url(): string;
  content(): Promise<string>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
}

export interface HealthOptions {
  /** Where to save the page when it is not healthy. Defaults to the data directory's `screenshots/`. */
  readonly screenshotsDir?: string;
  readonly now?: () => Date;
}

/**
 * Classifies the page as it is now (no navigation) and throws the matching
 * typed error unless the session is ok. Every driver function starts here.
 * On a non-ok page it saves a screenshot and the HTML first and puts their
 * paths in the error.
 */
export async function assertHealthy(page: InspectablePage, options: HealthOptions = {}): Promise<PageClassification> {
  const url = page.url();
  let html: string;
  try {
    html = await page.content();
  } catch (cause) {
    throw new Unexpected(`could not read the page at ${url}`, { cause });
  }

  const result = classifyPage({ url, html });
  if (result.state === "ok") return result;

  const artifacts = await savePage(page, html, result.state, options);
  const where = `screenshot ${artifacts.screenshot ?? "(failed)"}, html ${artifacts.html}`;
  throw errorFor(result.state, `session ${result.state}: ${result.evidence}. Saved ${where}`, { artifacts });
}

function errorFor(state: Exclude<SessionState, "ok">, message: string, options: LinkedInErrorOptions): LinkedInError {
  switch (state) {
    case "logged_out":
      return new LoggedOut(message, options);
    case "checkpoint":
      return new Checkpoint(message, options);
    case "restricted":
      return new Restricted(message, options);
    case "unknown":
      return new Unexpected(message, options);
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** Saves the page as it is now (HTML and a full-page screenshot) for a page the driver will not act on. */
export async function savePage(
  page: InspectablePage,
  html: string,
  state: SessionState,
  { screenshotsDir = dataPaths().screenshots, now = () => new Date() }: HealthOptions,
): Promise<PageArtifacts> {
  mkdirSync(screenshotsDir, { recursive: true });
  const base = join(screenshotsDir, `${now().toISOString().replace(/[:.]/g, "-")}-${state}`);
  const htmlPath = `${base}.html`;
  writeFileSync(htmlPath, html);
  const screenshotPath = `${base}.png`;
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return { screenshot: screenshotPath, html: htmlPath };
  } catch {
    return { screenshot: undefined, html: htmlPath };
  }
}
