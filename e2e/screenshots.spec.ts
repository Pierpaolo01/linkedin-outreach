import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { appUrl } from "./apps";

// Screenshots for the milestone report, of the seeded demo apps before any test changes them.
// Run on their own:  SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
// They are skipped in a normal run, where the other tests change the seeded data first.
// With SHOT_DIR=<name> (before, after) they go to docs/milestones/img/<name>/ as <page>-desktop.png and
// <page>-phone.png, every page on both, and sideways scroll is written to overflow.json there instead of failing.

const SHOT_DIR = process.env["SHOT_DIR"];
const OUT = join(import.meta.dirname, "..", "docs", "milestones", "img", SHOT_DIR ?? "");
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

test.skip(process.env["SCREENSHOTS"] !== "1", "Set SCREENSHOTS=1 to write the milestone screenshots");

async function shoot(page: Page, url: string, file: string, size: { width: number; height: number }, ready: (page: Page) => Promise<void>) {
  await page.setViewportSize(size);
  await page.goto(url);
  await ready(page);
  await page.evaluate(() => document.fonts.ready);
  // Leave nothing focused or hovered, so the shot shows the resting page.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.mouse.move(0, 0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (SHOT_DIR) recordOverflow(file, Math.max(0, overflow));
  else expect(overflow, `${file} scrolls sideways`).toBeLessThanOrEqual(0);
  // Grow the viewport to the page height, so the fixed sidebar sits where it would at the end of a scroll.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  if (height > size.height) await page.setViewportSize({ width: size.width, height });
  // Let the page lay out again at the new size before the shot.
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, file) });
}

function recordOverflow(file: string, pixels: number) {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, "overflow.json");
  const all: Record<string, number> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  all[file] = pixels;
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

type Target = { page: Page; size: { width: number; height: number }; kind: "desktop" | "phone" };

// The desktop page, plus with SHOT_DIR a phone page in its own context (deviceScaleFactor 2).
async function targets(page: Page, browser: Browser): Promise<Target[]> {
  const desktop: Target = { page, size: DESKTOP, kind: "desktop" };
  if (!SHOT_DIR) return [desktop];
  const phone = await (await browser.newContext({ deviceScaleFactor: 2 })).newPage();
  return [desktop, { page: phone, size: PHONE, kind: "phone" }];
}

// One page on every target: the m3 file name without SHOT_DIR, <name>-desktop/phone.png with it.
async function shootAll(all: Target[], url: string, m3File: string, name: string, ready: (page: Page) => Promise<void>) {
  for (const t of all) await shoot(t.page, url, SHOT_DIR ? `${name}-${t.kind}.png` : m3File, t.size, ready);
}

const homeReady = async (p: Page) => {
  await expect(p.getByTestId("needs-you")).toContainText("waiting for your approval");
  await expect(p.getByRole("table")).toContainText("Hotel owners, Rome");
  await expect(p.getByRole("region", { name: "What the app did" }).getByRole("listitem").first()).toBeVisible();
};
const queueReady = async (p: Page) => {
  await expect(p.getByTestId("approval-row")).toHaveCount(8);
};

test.describe("desktop", () => {
  test.use({ deviceScaleFactor: 1 });

  test("milestone 3 screenshots", async ({ page, browser }) => {
    const all = await targets(page, browser);
    await shootAll(all, appUrl("demo"), "m3-home.png", "home", homeReady);
    await shootAll(all, appUrl("stop"), "m3-home-safety-stop.png", "home-safety-stop", async (p) => {
      await expect(p.getByTestId("safety-stop")).toBeVisible();
      await homeReady(p);
    });
    await shootAll(all, appUrl("demo", "/approvals"), "m3-approvals.png", "approvals", queueReady);
    await shootAll(all, appUrl("demo", "/review"), "m3-needs-review.png", "needs-review", async (p) => {
      await expect(p.getByTestId("review-item")).toHaveCount(2);
      await expect(p.getByText(/held today/)).toHaveCount(2);
    });
  });
});

test.describe("desktop, the remaining screens", () => {
  test.use({ deviceScaleFactor: 1 });

  test("milestone 3 screenshots of campaigns, detail, activity, stats, settings and the wizard", async ({ page, browser }) => {
    const all = await targets(page, browser);
    await shootAll(all, appUrl("demo", "/campaigns"), "m3-campaigns.png", "campaigns", async (p) => {
      await expect(p.getByTestId("campaign-row")).toHaveCount(5);
      await expect(p.getByText(/monthly search limit/)).toBeVisible();
    });
    await shootAll(all, appUrl("demo", "/campaigns/1"), "m3-campaign-detail.png", "campaign-detail", async (p) => {
      await expect(p.getByTestId("prospect-row")).toHaveCount(20);
      await p.getByTestId("prospect-row").nth(15).getByRole("button").first().click();
      await expect(p.getByTestId("prospect-detail")).toContainText("Texts as sent");
    });
    await shootAll(all, appUrl("demo", "/activity"), "m3-activity.png", "activity", async (p) => {
      await expect(p.getByTestId("activity-line").first()).toBeVisible();
    });
    await shootAll(all, appUrl("demo", "/stats"), "m3-stats.png", "stats", async (p) => {
      await expect(p.getByTestId("stats-row")).toHaveCount(5);
    });
    await shootAll(all, appUrl("demo", "/settings"), "m3-settings.png", "settings", async (p) => {
      await expect(p.getByTestId("backups")).toBeVisible();
      await expect(p.getByTestId("service-state")).not.toBeEmpty();
    });

    // The wizard, last because it adds a draft campaign. Each target makes its own new draft:
    // Who fits as he first sees it (empty), then Messages with test strings.
    for (const t of all) {
      const one = [t];
      await shootAll(one, appUrl("demo", "/campaigns/new"), "m3-wizard-who-fits.png", "wizard-who-fits", async (p) => {
        await p.getByLabel("Campaign name").fill("Test campaign");
        await p.getByRole("button", { name: "Save and continue" }).click();
        await expect(p).toHaveURL(/\/campaigns\/\d+\/edit$/);
        await p.getByRole("button", { name: "Save and continue" }).click();
        await expect(p.getByLabel("Who fits this campaign, and who does not")).toHaveValue("");
      });
      await shootAll(one, t.page.url(), "m3-wizard-messages.png", "wizard-messages", async (p) => {
        await p.getByLabel("Who fits this campaign, and who does not").fill("Test targeting: invented founders of invented companies.");
        await p.getByRole("button", { name: "Save and continue" }).click();
        await p.getByRole("button", { name: "Save and continue" }).click();
        await p.getByLabel(/^Invite note/).fill("Test note for {{first_name}}.");
        await p.getByLabel(/^First message/).fill("Test first message for {{first_name}} at {{company}}.");
        await expect(p.getByTestId("preview")).toContainText("Test first message for Anna at Example Srl.");
      });
    }
  });
});

test.describe("phone", () => {
  test.use({ deviceScaleFactor: 2 });
  // With SHOT_DIR every page is already shot on the phone above.
  test.skip(Boolean(SHOT_DIR), "SHOT_DIR shoots every page on the phone");

  test("milestone 3 phone screenshot", async ({ page }) => {
    await shoot(page, appUrl("demo", "/approvals"), "m3-approvals-phone.png", PHONE, queueReady);
  });
});
