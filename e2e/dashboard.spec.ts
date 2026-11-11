import { expect, test } from "@playwright/test";

// The app runs on the fake driver (see playwright.config.ts). Nothing here touches LinkedIn.

/** A second app whose fake session is scripted to a checkpoint. */
const CHECKPOINT_URL = "http://127.0.0.1:4750/";

test("Home shows the session state and Re-check updates it", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("banner")).toContainText("LinkedIn outreach");
  // The startup check found the first scripted state.
  await expect(page.getByTestId("session-status")).toHaveText("Logged out");
  await expect(page.getByText("Log in to LinkedIn in the dedicated window, then press Re-check")).toBeVisible();
  await expect(page.getByTestId("last-checked")).toContainText("Last checked");

  const recheck = page.getByRole("button", { name: "Re-check" });
  await recheck.click();
  await expect(recheck).toBeDisabled();
  await expect(recheck.locator(".loading")).toBeVisible();

  await expect(page.getByTestId("session-status")).toHaveText("Connected");
  await expect(recheck).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a checkpoint shows the red safety-stop banner", async ({ page }) => {
  await page.goto(CHECKPOINT_URL);

  await expect(page.getByTestId("session-status")).toHaveText("Checkpoint");
  const banner = page.getByRole("alert");
  await expect(banner).toContainText("All LinkedIn activity is stopped");
  await expect(banner).toHaveClass(/alert-error/);
});
