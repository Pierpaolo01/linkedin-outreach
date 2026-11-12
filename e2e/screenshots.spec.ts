import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { appUrl } from "./apps";

// Screenshots for the milestone report, of the seeded demo apps before any test changes them.
// Run on their own:  SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
// They are skipped in a normal run, where the other tests change the seeded data first.

const OUT = join(import.meta.dirname, "..", "docs", "milestones", "img");
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
  expect(overflow, `${file} scrolls sideways`).toBeLessThanOrEqual(0);
  // Grow the viewport to the page height, so the fixed sidebar sits where it would at the end of a scroll.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  if (height > size.height) await page.setViewportSize({ width: size.width, height });
  // Let the page lay out again at the new size before the shot.
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, file) });
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

  test("milestone 3 screenshots", async ({ page }) => {
    await shoot(page, appUrl("demo"), "m3-home.png", DESKTOP, homeReady);
    await shoot(page, appUrl("stop"), "m3-home-safety-stop.png", DESKTOP, async (p) => {
      await expect(p.getByTestId("safety-stop")).toBeVisible();
      await homeReady(p);
    });
    await shoot(page, appUrl("demo", "/approvals"), "m3-approvals.png", DESKTOP, queueReady);
    await shoot(page, appUrl("demo", "/review"), "m3-needs-review.png", DESKTOP, async (p) => {
      await expect(p.getByTestId("review-item")).toHaveCount(2);
      await expect(p.getByText(/held today/)).toHaveCount(2);
    });
  });
});

test.describe("desktop, the remaining screens", () => {
  test.use({ deviceScaleFactor: 1 });

  test("milestone 3 screenshots of campaigns, detail, activity, stats, settings and the wizard", async ({ page }) => {
    await shoot(page, appUrl("demo", "/campaigns"), "m3-campaigns.png", DESKTOP, async (p) => {
      await expect(p.getByTestId("campaign-row")).toHaveCount(5);
      await expect(p.getByText(/monthly search limit/)).toBeVisible();
    });
    await shoot(page, appUrl("demo", "/campaigns/1"), "m3-campaign-detail.png", DESKTOP, async (p) => {
      await expect(p.getByTestId("prospect-row")).toHaveCount(20);
      await p.getByTestId("prospect-row").nth(15).getByRole("button").first().click();
      await expect(p.getByTestId("prospect-detail")).toContainText("Texts as sent");
    });
    await shoot(page, appUrl("demo", "/activity"), "m3-activity.png", DESKTOP, async (p) => {
      await expect(p.getByTestId("activity-line").first()).toBeVisible();
    });
    await shoot(page, appUrl("demo", "/stats"), "m3-stats.png", DESKTOP, async (p) => {
      await expect(p.getByTestId("stats-row")).toHaveCount(5);
    });
    await shoot(page, appUrl("demo", "/settings"), "m3-settings.png", DESKTOP, async (p) => {
      await expect(p.getByTestId("backups")).toBeVisible();
      await expect(p.getByTestId("service-state")).not.toBeEmpty();
    });

    // The wizard, on a new draft: Who fits as he first sees it (empty), then Messages with test strings.
    await shoot(page, appUrl("demo", "/campaigns/new"), "m3-wizard-who-fits.png", DESKTOP, async (p) => {
      await p.getByLabel("Campaign name").fill("Test campaign");
      await p.getByRole("button", { name: "Save and continue" }).click();
      await expect(p).toHaveURL(/\/campaigns\/\d+\/edit$/);
      await p.getByRole("button", { name: "Save and continue" }).click();
      await expect(p.getByLabel("Who fits this campaign, and who does not")).toHaveValue("");
    });
    const draft = page.url();
    await shoot(page, draft, "m3-wizard-messages.png", DESKTOP, async (p) => {
      await p.getByLabel("Who fits this campaign, and who does not").fill("Test targeting: invented founders of invented companies.");
      await p.getByRole("button", { name: "Save and continue" }).click();
      await p.getByRole("button", { name: "Save and continue" }).click();
      await p.getByLabel(/^Invite note/).fill("Test note for {{first_name}}.");
      await p.getByLabel(/^First message/).fill("Test first message for {{first_name}} at {{company}}.");
      await expect(p.getByTestId("preview")).toContainText("Test first message for Anna at Example Srl.");
    });
  });
});

test.describe("phone", () => {
  test.use({ deviceScaleFactor: 2 });

  test("milestone 3 phone screenshot", async ({ page }) => {
    await shoot(page, appUrl("demo", "/approvals"), "m3-approvals-phone.png", PHONE, queueReady);
  });
});
