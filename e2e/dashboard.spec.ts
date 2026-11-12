import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { appUrl } from "./apps";

// A route handler that re-fetches a response can still be running when its test ends (the dashboard
// polls). Let such a handler finish or fail quietly instead of failing a test that already passed.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

// The apps run on the fake driver with the engine off (see playwright.config.ts). Nothing here
// touches LinkedIn. "demo" and "stop" are seeded with invented people by scripts/seed-demo.ts.
// Tests on the demo app change its data, so each one reads the counts it starts from.

/** A 16 by 9 grey PNG standing in for a screenshot of a LinkedIn page. */
const TEST_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAEklEQVR4nGM4QSJgGNUwKDQAAMV3UZCpNc7sAAAAAElFTkSuQmCC";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });

async function badge(page: Page, which: "approvals" | "review"): Promise<number> {
  const locator = page.getByTestId(`count-${which}`);
  await expect(locator).toBeVisible();
  return Number(await locator.innerText());
}

/** The stage of the prospect for `fullName`, read through the API. */
async function stageOf(request: APIRequestContext, fullName: string): Promise<string | undefined> {
  const { campaigns } = (await (await request.get("/api/campaigns")).json()) as { campaigns: { id: number }[] };
  for (const { id } of campaigns) {
    const page = (await (await request.get(`/api/campaigns/${id}/prospects?pageSize=200`)).json()) as {
      items: { stage: string; person: { fullName: string } }[];
    };
    const found = page.items.find((item) => item.person.fullName === fullName);
    if (found !== undefined) return found.stage;
  }
  return undefined;
}

test("Home reads what needs you as sentences and shows today's usage", async ({ page }) => {
  await page.goto("/");

  const needs = page.getByTestId("needs-you");
  await expect(needs.getByText("8 prospects are waiting for your approval.")).toBeVisible();
  await expect(needs).toContainText("5 in Hotel owners, Rome and 3 in Local trades, Milan.");
  await expect(needs.getByText("2 people are held for review.")).toBeVisible();
  await expect(needs).toContainText("Test Person 6 and Test Person 24.");

  await expect(page.getByTestId("usage-message")).toContainText("4 of 10");
  await expect(page.getByTestId("usage-discovery_page")).toContainText("10 of 10");
  await expect(page.getByTestId("usage-discovery_page")).toContainText(/Limit reached, resumes (tomorrow|today|Monday|\w+day) \d\d:\d\d/);

  const campaigns = page.getByRole("region", { name: "Campaigns" }).getByRole("table");
  await expect(campaigns).toContainText("Hotel owners, Rome");
  await expect(campaigns).toContainText("Waiting for approval");
  await expect(campaigns.getByRole("button", { name: "Resume Restaurants, Naples" })).toBeVisible();

  await expect(page.getByRole("region", { name: "What the app did" }).getByRole("listitem").first()).toBeVisible();
  expect(await badge(page, "approvals")).toBe(8);
  expect(await badge(page, "review")).toBe(2);

  // Pause and resume a campaign from the table.
  await campaigns.getByRole("button", { name: "Pause Hotel owners, Rome" }).click();
  await expect(campaigns.getByRole("button", { name: "Resume Hotel owners, Rome" })).toBeVisible();
  await campaigns.getByRole("button", { name: "Resume Hotel owners, Rome" }).click();
  await expect(campaigns.getByRole("button", { name: "Pause Hotel owners, Rome" })).toBeVisible();
});

test("Home: a failed first load says so in words, with a button to try again", async ({ page }) => {
  let failing = true;
  await page.route("**/api/home", (route) => (failing ? route.fulfill({ status: 500, json: { error: "test: home unavailable" } }) : route.fallback()));
  await page.goto("/");
  await expect(page.getByText("Could not load Home: test: home unavailable")).toBeVisible();
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("needs-you")).toBeVisible();
  await expect(page.getByText("Could not load Home")).toHaveCount(0);
});

test("the approval queue shows each follow-up folded under the first message, or No follow-up", async ({ page }) => {
  await page.goto("/approvals");
  const rows = page.getByTestId("approval-row");

  // Hotel owners, Rome has a follow-up: folded away until opened.
  await page.getByLabel("Campaign").selectOption({ label: "Hotel owners, Rome" });
  await expect(rows).toHaveCount(5);
  const followUps = page.getByTestId("follow-up");
  await expect(followUps).toHaveCount(5);
  const first = rows.first().getByTestId("follow-up");
  const text = first.locator("p");
  await expect(text).toBeHidden();
  await first.getByText("Follow-up, if they do not reply").click();
  await expect(text).toBeVisible();
  await expect(text).toContainText("just checking whether my last message reached you.");
  await expect(rows.filter({ hasText: "No follow-up" })).toHaveCount(0);

  // Local trades, Milan has none.
  await page.getByLabel("Campaign").selectOption({ label: "Local trades, Milan" });
  await expect(rows).toHaveCount(3);
  await expect(followUps).toHaveCount(0);
  await expect(rows.filter({ hasText: "No follow-up" })).toHaveCount(3);
});

test("approval queue: the row A and R act on shows a ring under keyboard focus, not while a control inside it has focus", async ({ page }) => {
  await page.goto("/approvals");
  const rows = page.getByTestId("approval-row");
  await expect(rows.nth(1)).toBeVisible();
  const name = (await rows.first().locator("p.font-semibold").innerText()).trim();
  await rows.first().getByText(name, { exact: true }).click();
  await page.keyboard.press("ArrowDown");
  const row = rows.nth(1);
  await expect(row).toBeFocused();
  const shadow = () => row.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(await shadow(), "the focused row has no Dark Moss ring").toContain(MOSS);

  // Into the row: the profile link has its own ring, and the row's ring gives way.
  await page.keyboard.press("Tab");
  const profile = row.getByRole("link", { name: /LinkedIn profile/ });
  await expect(profile).toBeFocused();
  await expectFocusRing(profile, INK);
  expect(await shadow(), "the row keeps its ring while the link inside it has focus").not.toContain(MOSS);
});

test("approve all shown at a minimum score of 8 sends exactly the ids on screen", async ({ page }) => {
  await page.goto("/approvals");
  const before = await badge(page, "approvals");

  await page.getByRole("button", { name: "8+" }).click();
  const rows = page.getByTestId("approval-row");
  await expect(rows).toHaveCount(3);
  for (const score of await rows.getByRole("cell", { name: /^Score/ }).allInnerTexts()) expect(Number(score)).toBeGreaterThanOrEqual(8);
  const shown = (await (await page.request.get("/api/approvals?minScore=8&pageSize=200")).json()) as { items: { id: number }[] };

  await page.getByRole("button", { name: "Approve all 3 shown" }).click();
  const dialog = page.getByRole("dialog", { name: "Approve all 3 prospects shown?" });
  await expect(dialog).toContainText("with a score of 8 or more will be invited");
  const sent = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/approvals/approve-all");
  await dialog.getByRole("button", { name: "Approve 3" }).click();
  const body = (await sent).postDataJSON() as { prospectIds: number[] };
  const ascending = (ids: readonly number[]) => [...ids].sort((x, y) => x - y);
  expect(Object.keys(body)).toEqual(["prospectIds"]);
  expect(ascending(body.prospectIds)).toEqual(ascending(shown.items.map((item) => item.id)));

  await expect(page.getByText("3 approved.")).toBeVisible();
  await expect(page.getByTestId("queue-empty")).toContainText("No prospects waiting with a score of 8 or more.");
  await expect(page.getByTestId("count-approvals")).toHaveText(String(before - 3));
  expect(await stageOf(page.request, "Test Person 1")).toBe("approved");
});

test("approve all says how many were no longer waiting", async ({ page }) => {
  // The answer is the browser test's own: nothing is approved on the app.
  await page.route("**/api/approvals/approve-all", (route) => route.fulfill({ json: { approved: 1, skipped: 1 } }));
  await page.goto("/approvals");
  await page.getByLabel("Campaign").selectOption({ label: "Local trades, Milan" });
  const rows = page.getByTestId("approval-row");
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "Approve all 2 shown" }).click();
  await page.getByRole("dialog", { name: "Approve all 2 prospects shown?" }).getByRole("button", { name: "Approve 2" }).click();
  await expect(page.getByText("1 approved, 1 no longer waiting.")).toBeVisible();
  await expect(rows).toHaveCount(0);
});

const LATE_PERSON = "Test Person scored later";
const LATE_ID = 990_001;

/**
 * Makes one more person wait, as if the engine had just scored them: Home counts one more and the
 * queue lists a copy of its first row under a new id. Only the browser test's answers change.
 */
async function routeLatePerson(page: Page, state: { arrived: boolean }) {
  await page.route("**/api/home", async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { needsYou: { pendingApproval: number } };
    const pendingApproval = json.needsYou.pendingApproval + (state.arrived ? 1 : 0);
    await route.fulfill({ response, json: { ...json, needsYou: { ...json.needsYou, pendingApproval } } });
  });
  await page.route(
    (url) => url.pathname === "/api/approvals",
    async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { total: number; items: { id: number; person: Record<string, unknown> }[] };
      const first = json.items[0];
      if (!state.arrived || first === undefined) return route.fulfill({ response, json });
      const late = { ...first, id: LATE_ID, person: { ...first.person, id: LATE_ID, fullName: LATE_PERSON } };
      await route.fulfill({ response, json: { ...json, total: json.total + 1, items: [late, ...json.items] } });
    },
  );
}

test("the approval queue takes in people scored while it is open, and keeps the selected row", async ({ page }) => {
  const state = { arrived: false };
  await routeLatePerson(page, state);
  await page.goto("/approvals");
  const before = await badge(page, "approvals");
  const rows = page.getByTestId("approval-row");
  await expect(rows).toHaveCount(before);
  const second = (await rows.locator("p.font-semibold").allInnerTexts())[1];
  if (second === undefined) throw new Error("Need two prospects");
  const secondRow = rows.filter({ has: page.getByText(second, { exact: true }) });
  await secondRow.getByText(second, { exact: true }).click();
  await expect(secondRow).toBeFocused();

  state.arrived = true;
  // Home is asked again every five seconds.
  await expect(page.getByTestId("count-approvals")).toHaveText(String(before + 1), { timeout: 8_000 });
  await expect(rows).toHaveCount(before + 1);
  await expect(rows.first()).toContainText(LATE_PERSON);
  await expect(secondRow).toBeFocused();
});

test("people scored while Approve all is open wait behind a line; the dialog approves only the rows it opened with", async ({ page }) => {
  const state = { arrived: false };
  await routeLatePerson(page, state);
  // The answer is the browser test's own: nothing is approved on the app.
  await page.route("**/api/approvals/approve-all", (route) => {
    const { prospectIds } = route.request().postDataJSON() as { prospectIds: number[] };
    return route.fulfill({ json: { approved: prospectIds.length, skipped: 0 } });
  });
  await page.goto("/approvals");
  const before = await badge(page, "approvals");
  const rows = page.getByTestId("approval-row");
  await expect(rows).toHaveCount(before);
  const shown = (await (await page.request.get("/api/approvals?pageSize=200")).json()) as { items: { id: number }[] };

  await page.getByRole("button", { name: `Approve all ${before} shown` }).click();
  const dialog = page.getByRole("dialog", { name: `Approve all ${before} prospects shown?` });
  await expect(dialog).toBeVisible();
  state.arrived = true;
  await expect(page.getByTestId("count-approvals")).toHaveText(String(before + 1), { timeout: 8_000 });
  await expect(page.getByTestId("new-arrivals")).toContainText("1 new person is waiting");
  await expect(rows).toHaveCount(before);
  await expect(rows.filter({ hasText: LATE_PERSON })).toHaveCount(0);

  const sent = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/approvals/approve-all");
  await dialog.getByRole("button", { name: `Approve ${before}` }).click();
  const body = (await sent).postDataJSON() as { prospectIds: number[] };
  const ascending = (ids: readonly number[]) => [...ids].sort((x, y) => x - y);
  expect(ascending(body.prospectIds)).toEqual(ascending(shown.items.map((item) => item.id)));
  expect(body.prospectIds).not.toContain(LATE_ID);
  // Once the dialog is closed the queue takes in the newcomer.
  await expect(rows.filter({ hasText: LATE_PERSON })).toHaveCount(1);
});

test("approve with the mouse, approve with A and reject with R; the counts drop", async ({ page }) => {
  await page.goto("/approvals");
  const before = await badge(page, "approvals");
  const rows = page.getByTestId("approval-row");
  await expect(rows).toHaveCount(before);
  const names = (await rows.locator("p.font-semibold").allInnerTexts()).slice(0, 4);
  const [first, second, third, fourth] = names;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) throw new Error("Need four prospects");

  // The profile opens in the user's normal browser.
  const profile = rows.first().getByRole("link", { name: /LinkedIn profile/ });
  await expect(profile).toHaveAttribute("target", "_blank");
  await expect(profile).toHaveAttribute("rel", "noreferrer");

  await rows.first().getByRole("button", { name: "Approve" }).click();
  await expect(rows.filter({ hasText: first })).toHaveCount(0);
  await expect(page.getByTestId("count-approvals")).toHaveText(String(before - 1));

  // Click a row to select it, then decide with the keys; the next row is selected each time.
  await rows.filter({ hasText: second }).getByText(second, { exact: true }).click();
  await expect(rows.filter({ hasText: second })).toBeFocused();
  await page.keyboard.press("a");
  await expect(rows.filter({ hasText: second })).toHaveCount(0);
  await expect(rows.filter({ hasText: third })).toBeFocused();
  await page.keyboard.press("r");
  await expect(rows.filter({ hasText: third })).toHaveCount(0);
  await expect(rows.filter({ hasText: fourth })).toBeFocused();

  await expect(page.getByTestId("count-approvals")).toHaveText(String(before - 3));
  await expect(page.getByText(`${before - 3} waiting, 3 decided`)).toBeVisible();
  expect(await stageOf(page.request, first)).toBe("approved");
  expect(await stageOf(page.request, second)).toBe("approved");
  expect(await stageOf(page.request, third)).toBe("rejected");
});

test("needs review: the screenshot opens at full size, and a person without a score says so", async ({ page }) => {
  // The browser test adds a screenshot and takes away a score; everything else is the app's answer.
  await page.route("**/test-screenshot.png", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(TEST_PNG, "base64") }));
  await page.route(
    (url) => url.pathname === "/api/review",
    async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { items: Record<string, unknown>[] };
      const items = json.items.map((item, i) => ({ ...item, screenshotUrl: i === 0 ? "/test-screenshot.png" : null, score: i === 0 ? null : item["score"] }));
      await route.fulfill({ response, json: { ...json, items } });
    },
  );
  await page.goto("/review");
  const items = page.getByTestId("review-item");
  await expect(items).toHaveCount(2);
  const first = items.first();
  const name = await first.getByRole("heading").innerText();

  await expect(first.getByTestId("review-score")).toHaveText("Not scored");
  await expect(items.nth(1).getByTestId("review-score")).toContainText(/^Score \d+ of 10: ./);
  await expect(page.getByTestId("screenshot-thumbnail")).toHaveCount(1);
  const thumbnail = first.getByRole("img", { name: `The LinkedIn page the app saw when it held ${name}` });
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await first.getByRole("button", { name: `Open the screenshot for ${name} at full size` }).click();
  const dialog = page.getByRole("dialog", { name: `Screenshot: ${name}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img", { name: `The LinkedIn page the app saw when it held ${name}` })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("needs review: a screenshot the app cannot serve is said in words, not shown broken", async ({ page }) => {
  await page.route("**/missing-test-screenshot.png", (route) => route.fulfill({ status: 404, json: { error: "test: no such screenshot" } }));
  await page.route(
    (url) => url.pathname === "/api/review",
    async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { items: Record<string, unknown>[] };
      const items = json.items.map((item, i) => ({ ...item, screenshotUrl: i === 0 ? "/missing-test-screenshot.png" : null }));
      await route.fulfill({ response, json: { ...json, items } });
    },
  );
  await page.goto("/review");
  const first = page.getByTestId("review-item").first();
  await expect(first.getByTestId("screenshot-missing")).toBeVisible();
  await expect(page.getByTestId("screenshot-thumbnail")).toHaveCount(0);
});

test("needs review: a person resolved and then held again by a later step comes back", async ({ page }) => {
  // The browser test plays the app: the resolve is answered here, and the later hold is added to
  // the answers of Home and of the review list. Nothing changes on the app.
  let phase: "held" | "resolved" | "held again" = "held";
  let target: Record<string, unknown> | undefined;
  await page.route("**/api/home", async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { needsYou: { needsReview: number } };
    const needsReview = json.needsYou.needsReview - (phase === "resolved" ? 1 : 0);
    await route.fulfill({ response, json: { ...json, needsYou: { ...json.needsYou, needsReview } } });
  });
  await page.route(
    (url) => url.pathname === "/api/review",
    async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { total: number; items: Record<string, unknown>[] };
      target ??= json.items[0];
      const items = json.items.flatMap((item) => {
        if (item["id"] !== target?.["id"]) return [item];
        if (phase === "resolved") return [];
        if (phase === "held again") return [{ ...item, stage: "needs_review", reviewReason: "test: held again on a later step", invitedAt: new Date().toISOString() }];
        return [item];
      });
      await route.fulfill({ response, json: { ...json, total: items.length, items } });
    },
  );
  await page.route(
    (url) => /^\/api\/prospects\/\d+\/resolve$/.test(url.pathname),
    async (route) => {
      phase = "resolved";
      await route.fulfill({ json: { prospect: { ...target, stage: "invited", reviewReason: null } } });
    },
  );

  await page.goto("/review");
  const items = page.getByTestId("review-item");
  await expect(items.first()).toBeVisible();
  const before = await items.count();
  const first = items.first();
  const name = await first.getByRole("heading").innerText();
  await first.getByRole("radio", { name: "Invited: wait for them to accept" }).check();
  await first.getByRole("button", { name: "Confirm" }).click();
  await expect(items.filter({ hasText: name })).toHaveCount(0);
  await expect(items).toHaveCount(before - 1);
  // Home has answered with the lower count, so the list has been asked for again without them.
  const badgeText = before - 1 === 0 ? undefined : String(before - 1);
  if (badgeText === undefined) await expect(page.getByTestId("count-review")).toHaveCount(0);
  else await expect(page.getByTestId("count-review")).toHaveText(badgeText);

  phase = "held again";
  // Home is asked again every five seconds; the higher count brings the list again.
  await expect(items.filter({ hasText: name })).toHaveCount(1, { timeout: 8_000 });
  await expect(items.filter({ hasText: name })).toContainText("held again on a later step");
});

test("needs review: nothing is chosen until you choose; continue one with a note, reject the other", async ({ page }) => {
  await page.goto("/review");
  const before = await badge(page, "review");
  const items = page.getByTestId("review-item");
  await expect(items).toHaveCount(before);

  // No default action for anyone: no choice made, Confirm off, approval offered only in words that say what it does.
  for (const item of await items.all()) {
    await expect(item.getByRole("radio")).toHaveCount(6);
    await expect(item.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(item.getByRole("radio", { name: "Approve: the invite will be sent" })).not.toBeChecked();
    await expect(item.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await expect(item.getByTestId("review-score")).toContainText(/^Score \d+ of 10/);
  }

  const first = items.first();
  const name = await first.getByRole("heading").innerText();
  await expect(first).toContainText("Why:");
  await first.getByLabel("Note for the activity log (optional)").fill("Checked by hand on LinkedIn");
  await first.getByRole("radio", { name: "Invited: wait for them to accept" }).check();
  await first.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByText(`${name} continues: the app waits for them to accept.`)).toBeVisible();
  await expect(items.filter({ hasText: name })).toHaveCount(0);
  expect(await stageOf(page.request, name)).toBe("invited");
  const activity = (await (await page.request.get("/api/activity?pageSize=20")).json()) as { items: { message: string }[] };
  expect(activity.items.some((line) => line.message.includes("Checked by hand on LinkedIn"))).toBe(true);

  const second = items.first();
  const secondName = await second.getByRole("heading").innerText();
  await second.getByRole("radio", { name: "Reject: take them out of this campaign" }).check();
  await second.getByRole("button", { name: "Confirm" }).click();
  await expect(items.filter({ hasText: secondName })).toHaveCount(0);
  expect(await stageOf(page.request, secondName)).toBe("rejected");

  await expect(page.getByTestId("review-empty")).toBeVisible();
  await expect(page.getByTestId("count-review")).toHaveCount(0);
});

test("every destination in the sidebar opens a page", async ({ page }) => {
  await page.goto("/");
  const nav = sidebar(page).getByRole("navigation", { name: "Main" });
  for (const [link, heading] of [
    ["Campaigns", "Campaigns"],
    ["Hotel owners, Rome", "Hotel owners, Rome"],
    ["Activity log", "Activity log"],
    ["Stats", "Stats"],
    ["Settings", "Settings"],
    ["Needs review", "Needs review"],
    ["Approval queue", "Approval queue"],
    ["Home", "Home"],
  ] as const) {
    await nav.getByRole("link", { name: link }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  }
  await page.goto("/nowhere");
  await expect(page.getByText("There is no page at this address.")).toBeVisible();
});

test("phone width: the sidebar becomes a menu and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/approvals", "/review", "/campaigns", "/campaigns/1", "/campaigns/new", "/activity", "/stats", "/settings"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator(".loading, .skeleton")).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
  }

  // A campaign's people: one block per person with each value named, nothing hidden sideways in the box,
  // and an opened person's texts inside the screen.
  await page.goto("/campaigns/1");
  const person = page.getByTestId("prospect-row").first();
  await expect(person.getByText("Company", { exact: true })).toBeVisible();
  await expect(person.getByText("Next action", { exact: true })).toBeVisible();
  const hidden = await page.getByTestId("people-table").evaluate((table) => (table.parentElement === null ? 0 : table.parentElement.scrollWidth - table.parentElement.clientWidth));
  expect(hidden, "the People box scrolls sideways").toBeLessThanOrEqual(0);
  await person.getByRole("button").first().click();
  const detailRight = await page.getByTestId("prospect-detail").evaluate((detail) => detail.getBoundingClientRect().right - window.innerWidth);
  expect(detailRight, "an opened person's texts run past the screen").toBeLessThanOrEqual(0);

  // Stats: one block per campaign, nothing hidden sideways.
  await page.goto("/stats");
  await expect(page.getByTestId("stats-row").first().getByText("Median time to accept", { exact: true })).toBeVisible();
  const statsHidden = await page.getByTestId("stats-table").evaluate((table) => (table.parentElement === null ? 0 : table.parentElement.scrollWidth - table.parentElement.clientWidth));
  expect(statsHidden, "the Stats box scrolls sideways").toBeLessThanOrEqual(0);

  // The approval queue: Approve and Reject are 44px targets on a phone.
  await page.goto("/approvals");
  const decide = page.getByTestId("approval-row").first();
  for (const name of ["Approve", "Reject"]) {
    const target = await decide.getByRole("button", { name }).boundingBox();
    expect(target?.height ?? 0, `${name} is too small to tap`).toBeGreaterThanOrEqual(44);
  }

  // Settings: the seven working-day buttons stay inside the screen, each tall enough to tap.
  await page.goto("/settings");
  const days = page.getByRole("group", { name: "Working days" });
  await expect(days.getByRole("button")).toHaveCount(7);
  const boxes = await Promise.all((await days.getByRole("button").all()).map((button) => button.boundingBox()));
  const placed = boxes.filter((box) => box !== null);
  expect(placed).toHaveLength(7);
  // The group's right edge, and every button's, stay inside the section that holds them (and so the screen).
  const edges = await days.evaluate((group) => ({
    group: group.getBoundingClientRect().right,
    section: group.closest("section")?.getBoundingClientRect().right ?? Number.NaN,
    screen: window.innerWidth,
  }));
  const right = Math.max(...placed.map((box) => box.x + box.width));
  expect(edges.section).toBeLessThanOrEqual(edges.screen);
  expect(edges.group, "the working-day group ends beyond its section").toBeLessThanOrEqual(edges.section);
  expect(right, "a working-day button ends beyond its section").toBeLessThanOrEqual(edges.section);
  for (const box of placed) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.height, "a working-day button is too short to tap").toBeGreaterThanOrEqual(40);
  }

  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toBeHidden();
  await page.getByLabel("Open menu").click();
  await expect(nav).toBeVisible();
  await nav.getByRole("link", { name: "Approval queue" }).click();
  await expect(page).toHaveURL(/\/approvals$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Approval queue");
  await expect(nav).toBeHidden();
});

/** The focus indicator drawn on an element: a solid outline at least 2px wide, in `rgb`. */
async function expectFocusRing(locator: ReturnType<Page["locator"]>, rgb: string) {
  const ring = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), color: style.outlineColor };
  });
  expect(ring.style, "the focused element draws no outline").toBe("solid");
  expect(ring.width, "the focus outline is thinner than 2px").toBeGreaterThanOrEqual(2);
  expect(ring.color).toBe(rgb);
}
const INK = "rgb(29, 37, 33)";
const ON_MOSS = "rgb(242, 244, 240)";
const MOSS = "rgb(38, 48, 43)";

test("keyboard: skip links first, a visible focus on sidebar items, and focus moves to the page you open", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to menu" })).toBeFocused();
  await page.keyboard.press("Enter");

  const nav = sidebar(page).getByRole("navigation", { name: "Main" });
  // The current page's item (Dark Moss) shows its focus in light ink; any other item in Ink.
  const home = nav.getByRole("link", { name: "Home" });
  await expect(home).toBeFocused();
  await expectFocusRing(home, ON_MOSS);
  await page.keyboard.press("Tab");
  const approvals = nav.getByRole("link", { name: "Approval queue" });
  await expect(approvals).toBeFocused();
  await expectFocusRing(approvals, INK);

  await page.keyboard.press("Enter");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Approval queue");
  await expect(heading).toBeFocused();
});

test("phone width: the menu is a modal; Escape and the overlay close it and give focus back to the menu button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
  const button = page.getByRole("button", { name: "Open menu" });
  const nav = page.getByRole("navigation", { name: "Main" });

  // Skip to content, then the menu button, which shows its focus.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  await expectFocusRing(button, INK);
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // Open: focus moves into the menu, and Tab never reaches the page behind it.
  await page.keyboard.press("Enter");
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link", { name: "Home" })).toBeFocused();
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) return "nowhere";
      return active.closest("aside") === null ? `page: ${active.textContent ?? ""}` : "menu";
    });
    expect(where === "menu" || where === "nowhere", `Tab reached the page behind the menu (${where})`).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(nav).toBeHidden();
  await expect(button).toBeFocused();

  await button.click();
  await expect(nav).toBeVisible();
  // The overlay is the strip to the right of the 16rem menu.
  await page.mouse.click(370, 400);
  await expect(nav).toBeHidden();
  await expect(button).toBeFocused();
});

test("the safety-stop banner says what to do, and Resume asks first", async ({ page }) => {
  await page.goto(appUrl("stop"));

  const banner = page.getByTestId("safety-stop");
  await expect(banner).toContainText("Safety stop. All LinkedIn activity is stopped.");
  await expect(banner).toContainText("LinkedIn is asking for a security check.");
  await expect(banner).toContainText("What to do: Complete LinkedIn's check in the app's window, then press Resume.");
  await expect(page.getByRole("region", { name: "Campaigns" })).toContainText("Stopped by safety stop");

  await banner.getByRole("button", { name: "Resume" }).click();
  const dialog = page.getByRole("dialog", { name: "Resume LinkedIn activity?" });
  await expect(dialog).toContainText("Before you resume: Complete LinkedIn's check in the app's window, then press Resume.");
  await dialog.getByRole("button", { name: "Not yet" }).click();
  await expect(dialog).toBeHidden();
  await expect(banner).toBeVisible();

  await banner.getByRole("button", { name: "Resume" }).click();
  await dialog.getByRole("button", { name: "I have done this, resume" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Campaigns" })).not.toContainText("Stopped by safety stop");
  const home = (await (await page.request.get(appUrl("stop", "/api/home"))).json()) as { safetyStop: unknown };
  expect(home.safetyStop).toBeNull();
});

test("Re-check updates the session, and an empty app shows its empty states", async ({ page }) => {
  await page.goto(appUrl("recheck"));

  // The startup check found the first scripted state.
  await expect(page.getByTestId("session-status")).toHaveText("Logged out");
  await expect(page.getByTestId("session-problem")).toContainText("Log in to LinkedIn in the dedicated window, then press Re-check.");
  await expect(page.getByTestId("last-checked")).toContainText("Last checked");
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();
  await expect(page.getByText("No campaigns yet.")).toBeVisible();

  const recheck = sidebar(page).getByRole("button", { name: "Re-check" });
  await recheck.click();
  await expect(recheck).toBeDisabled();
  await expect(recheck.locator(".loading")).toBeVisible();

  await expect(page.getByTestId("session-status")).toHaveText("Connected");
  await expect(recheck).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await sidebar(page).getByRole("link", { name: "Approval queue" }).click();
  await expect(page.getByText("The approval queue is empty.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve all 0 shown" })).toBeDisabled();
});

test("a checkpoint shows the red banner with what to do", async ({ page }) => {
  await page.goto(appUrl("checkpoint"));

  await expect(page.getByTestId("session-status")).toHaveText("Checkpoint");
  const banner = page.getByRole("alert");
  await expect(banner).toContainText("LinkedIn needs you.");
  await expect(banner).toContainText("LinkedIn is asking for a security check in the dedicated window");
  await expect(banner.getByRole("button", { name: "Re-check" })).toBeVisible();
});
