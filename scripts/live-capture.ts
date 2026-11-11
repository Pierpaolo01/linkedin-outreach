/**
 * `npm run live:capture -- <url> <name>`
 *
 * Saves one real LinkedIn page as `captures/<name>.html` and `captures/<name>.png`
 * for writing parsers. `captures/` is git-ignored: it holds real people's data.
 *
 * Read-only: it loads the page, checks its health, scrolls slowly so lazy
 * content loads, and saves it. It never clicks or types. It waits a random
 * 20–40 s after the previous LinkedIn navigation from any run before loading.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDedicatedWindow, ProfileInUse, type DedicatedWindow } from "../src/linkedin/browser";
import { LinkedInError } from "../src/linkedin/errors";
import { humanDelay, navigationStateFile, paceNavigation, randomInt } from "../src/linkedin/human";
import { assertHealthy } from "../src/linkedin/pageHealth";
import { settle } from "../src/linkedin/session";

const CAPTURES_DIR = fileURLToPath(new URL("../captures/", import.meta.url));
const USAGE = "usage: npm run live:capture -- <https://www.linkedin.com/...> <name>";

type Args = { readonly url: string; readonly name: string } | { readonly error: string };

function parseArgs(argv: readonly string[]): Args {
  const [rawUrl, name, ...rest] = argv.filter((arg) => arg !== "--");
  if (rawUrl === undefined || name === undefined || rest.length > 0) return { error: USAGE };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: `not a URL: ${rawUrl}` };
  }
  if (url.protocol !== "https:" || url.hostname !== "www.linkedin.com" || url.username || url.password) {
    return { error: `refusing ${rawUrl}: only https://www.linkedin.com pages may be captured` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.includes("..")) {
    return { error: `bad name ${name}: use letters, digits, dot, dash and underscore` };
  }
  return { url: url.href, name };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    return 2;
  }

  let window: DedicatedWindow;
  try {
    window = await openDedicatedWindow();
  } catch (error) {
    if (error instanceof ProfileInUse) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  process.once("SIGINT", () => void window.close().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void window.close().finally(() => process.exit(143)));

  try {
    const waited = await paceNavigation({ stateFile: navigationStateFile(), minGapMs: 20_000, maxGapMs: 40_000 });
    if (waited > 0) console.log(`waited ${Math.round(waited / 1000)} s since the last LinkedIn navigation`);

    const { page } = window;
    await page.goto(args.url, { waitUntil: "domcontentloaded" });
    await settle(page);
    console.log(`session: ${(await assertHealthy(page)).state}`);

    const scrolls = randomInt({ min: 3, max: 5 });
    for (let i = 0; i < scrolls; i += 1) {
      await page.mouse.wheel(0, randomInt({ min: 500, max: 900 }));
      await humanDelay({ minMs: 1_500, maxMs: 3_500 });
    }
    await assertHealthy(page);

    mkdirSync(CAPTURES_DIR, { recursive: true });
    const base = join(CAPTURES_DIR, args.name);
    writeFileSync(`${base}.html`, await page.content());
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    console.log(`saved ${base}.html and ${base}.png`);
    return 0;
  } catch (error) {
    if (error instanceof LinkedInError) {
      console.error(`stopped: ${error.kind}. ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await window.close().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
