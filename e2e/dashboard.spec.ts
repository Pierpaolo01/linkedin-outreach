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

/** The baseline of each element's first line: the top of an empty inline-block put at its start (its bottom edge sits on the baseline). */
async function baselines(locator: ReturnType<Page["locator"]>): Promise<number[]> {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      element.prepend(probe);
      const top = probe.getBoundingClientRect().top;
      probe.remove();
      return top;
    }),
  );
}

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
  await expect(needs.getByText("8 Prospects waiting for your approval", { exact: true })).toBeVisible();
  await expect(needs).toContainText("5 in Hotel owners, Rome and 3 in Local trades, Milan.");
  await expect(needs.getByText("2 People held for review", { exact: true })).toBeVisible();
  await expect(needs).toContainText("Test Person 6 and Test Person 24.");

  await expect(page.getByTestId("usage-message")).toContainText("4 of 10");
  await expect(page.getByTestId("usage-discovery_page")).toContainText("10 of 10");
  // One form in every state: when the budget resets, which is true with or without a safety stop. The time is one phrase.
  await expect(page.getByTestId("usage-discovery_page")).toContainText(/Budget spent; it resets (tomorrow|today|\w+day|\d+\s\w+)\u00a0\d\d:\d\d/);
  await expect(page.getByTestId("usage-discovery_page")).not.toContainText("resumes");
  // A spent budget is quiet: its meter is the solid muted tone (never amber, never darker than the green bars) and its
  // line is muted like every other line under a meter. The words carry the state.
  // The full meter is the control tone, lighter than the muted words (so it is not the darkest block in the card), on
  // Desk Paper inside the control-tone edge, which reaches 3:1 on the card.
  await expect(page.getByTestId("usage-discovery_page").locator("progress")).toHaveCSS("color", CONTROL);
  await expect(page.getByTestId("usage-discovery_page").locator("progress")).toHaveCSS("border-top-color", CONTROL);
  await expect(page.getByTestId("usage-discovery_page").locator("p")).toHaveCSS("color", MUTED);

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
  await expect(page.getByText("Could not load Home. Nothing was changed; press Try again.")).toBeVisible();
  await expect(page.getByText("What the app said: test: home unavailable.")).toBeVisible();
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
  // The disclosure draws the app's chevron, not the browser's triangle, and turns it when open.
  const summary = first.locator("summary");
  await expect(summary).toHaveCSS("list-style-type", "none");
  const chevron = summary.locator("svg");
  await expect(chevron).toHaveCount(1);
  await expect(chevron).not.toHaveCSS("rotate", "90deg");
  await first.getByText("Follow-up, if they do not reply").click();
  await expect(text).toBeVisible();
  await expect(chevron).toHaveCSS("rotate", "90deg");

  // Only what a variable filled in is set at 500: the invite note's "{{first_name}}", never the user's own "in Rome".
  const note = rows.first().getByTestId("sent-text").first();
  await expect(note).toContainText("I work with independent hotels in Rome and would like to connect.");
  await expect(note.locator(".font-medium")).toHaveCount(1);
  const message = rows.first().getByTestId("sent-text").nth(1);
  await expect(message.locator(".font-medium")).toHaveCount(2);
  await expect(message.locator(".font-medium").first()).toHaveText(await note.locator(".font-medium").innerText());
  await expect(text).toContainText("just checking whether my last message reached you.");
  await expect(rows.filter({ hasText: "No follow-up" })).toHaveCount(0);

  // Local trades, Milan has none.
  await page.getByLabel("Campaign").selectOption({ label: "Local trades, Milan" });
  await expect(rows).toHaveCount(3);
  await expect(followUps).toHaveCount(0);
  await expect(rows.filter({ hasText: "No follow-up" })).toHaveCount(3);
});

test("an opened person's texts as sent set apart what the variables filled in, as the queue does", async ({ page }) => {
  await page.goto("/campaigns/1");
  const row = page.getByTestId("prospect-row").filter({ hasText: "Owner at Hotel Navona Test" });
  await row.getByRole("button").first().click();
  const texts = page.getByTestId("prospect-detail").getByTestId("sent-text");
  await expect(texts).toHaveCount(2);
  // The invite note: only "{{first_name}}"; the user's own "in Rome" stays plain.
  await expect(texts.first()).toContainText("I work with independent hotels in Rome");
  await expect(texts.first().locator(".font-medium")).toHaveText(["Test"]);
  // The first message: "{{first_name}}" and "{{company}}".
  await expect(texts.nth(1).locator(".font-medium")).toHaveText(["Test", "Hotel Navona Test"]);
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

test("a confirm dialog stays open on Escape while its action runs, so a failure is still shown", async ({ page }) => {
  // The answer is the browser test's own, held until the test lets it go: nothing is approved on the app.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/approvals/approve-all", async (route) => {
    await held;
    await route.fulfill({ status: 500, json: { error: "test: approvals unavailable" } });
  });
  await page.goto("/approvals");
  await page.getByLabel("Campaign").selectOption({ label: "Local trades, Milan" });
  const rows = page.getByTestId("approval-row");
  // Earlier tests decide people on the demo app, so read how many wait.
  await expect(rows.first()).toBeVisible();
  const shown = await rows.count();
  await page.getByRole("button", { name: `Approve all ${shown} shown` }).click();
  const dialog = page.getByRole("dialog", { name: `Approve all ${shown} ${shown === 1 ? "prospect" : "prospects"} shown?` });
  const confirm = dialog.getByRole("button", { name: `Approve ${shown}` });
  let sent = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/approvals/approve-all") sent += 1;
  });
  const fill = await confirm.evaluate((button) => getComputedStyle(button).backgroundColor);
  await confirm.click();
  // While it runs, the button keeps the focus and its colour, says what it is doing, and ignores a second press; Cancel is inert.
  const busy = dialog.getByRole("button", { name: "Approving…" });
  await expect(busy).toBeFocused();
  await expect(busy).toHaveAttribute("aria-disabled", "true");
  await expect(busy).toHaveAttribute("aria-busy", "true");
  await expect(busy).toHaveCSS("background-color", fill);
  await expect(busy.locator(".loading")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  // Playwright waits for an aria-disabled button to be enabled; this press is meant to land while it is busy.
  await busy.click({ force: true });
  expect(sent).toBe(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog.getByRole("alert")).toContainText("test: approvals unavailable");
  await expect(confirm).toBeEnabled();
  await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
  // Once the action has ended, Escape closes it again.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(rows).toHaveCount(shown);
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
  // A sentence in the app's style: a full stop, no dash.
  await expect(page.getByTestId("new-arrivals")).toHaveText("1 new person is waiting. Close this to see them.");
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

test("phone width: the profile links in the approval queue and in needs review are 44px targets that do not grow the row", async ({ page }) => {
  // Before the needs-review tests below resolve the held people.
  await page.setViewportSize({ width: 390, height: 844 });
  const tall = async (link: ReturnType<Page["locator"]>, what: string) => {
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box?.height ?? 0, `${what} is too small to tap`).toBeGreaterThanOrEqual(44);
    // The hit area overhangs the line it sits on (negative margins), so the layout keeps its 24px line.
    const space = await link.evaluate((el) => {
      const style = getComputedStyle(el);
      return el.getBoundingClientRect().height + Number.parseFloat(style.marginTop) + Number.parseFloat(style.marginBottom);
    });
    expect(space, `${what} takes more room than its line`).toBeLessThanOrEqual(28);
  };
  await page.goto("/approvals");
  await tall(page.getByTestId("approval-row").first().getByRole("link", { name: /^LinkedIn profile/ }), "the queue's profile link");
  await page.goto("/review");
  await tall(page.getByTestId("review-item").first().getByRole("link", { name: /^LinkedIn profile/ }), "the review's profile link");
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

test("the sidebar marks exactly one item as the current page on every page, a draft's wizard address too", async ({ page }) => {
  const nav = sidebar(page).getByRole("navigation", { name: "Main" });
  const { campaigns } = (await (await page.request.get("/api/campaigns")).json()) as { campaigns: { id: number; name: string; status: string }[] };
  const draft = campaigns.find((c) => c.status === "draft");
  const listed = campaigns.find((c) => c.status === "running");
  expect(draft, "the demo has a draft").toBeDefined();
  expect(listed, "the demo has a running campaign").toBeDefined();
  for (const [path, current] of [
    ["/", "Home"],
    ["/approvals", "Approval queue"],
    ["/review", "Needs review"],
    ["/campaigns", "Campaigns"],
    ["/campaigns/new", "Campaigns"],
    [`/campaigns/${draft?.id}/edit`, "Campaigns"],
    [`/campaigns/${listed?.id}`, listed?.name ?? ""],
    ["/activity", "Activity log"],
    ["/stats", "Stats"],
    ["/settings", "Settings"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The campaigns in the sidebar come with Home's data: wait for them, so a campaign's own entry can be current.
    await expect(nav.getByRole("link", { name: new RegExp(`^${listed?.name ?? ""}`) })).toBeVisible();
    const marked = nav.locator('[aria-current="page"]');
    await expect(marked, path).toHaveCount(1);
    await expect(marked, path).toHaveAccessibleName(new RegExp(`^${current}( ?,| \\d|$)`));
    await expect(nav.locator(".menu-active"), path).toHaveCount(1);
    await expect(marked, path).toHaveClass(/menu-active/);
  }
});

test("the sidebar shows a long campaign name on two lines, with the full name on hover, its dot on the first line", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const long = "Test campaign with a long name for independent hotel owners in the historic centre of Rome";
  await page.route("**/api/home", async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { campaigns: { name: string }[] };
    await route.fulfill({ response, json: { ...json, campaigns: json.campaigns.map((c, i) => (i === 0 ? { ...c, name: long } : c)) } });
  });
  await page.goto("/");
  const link = sidebar(page).getByRole("link", { name: new RegExp(`^${long}`) });
  await expect(link).toHaveAttribute("title", long);
  const name = link.getByTestId("sidebar-campaign-name");
  await expect(name).toHaveCSS("-webkit-line-clamp", "2");
  const lineHeight = await name.evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight));
  const box = await name.boundingBox();
  const dot = await link.locator(".status").boundingBox();
  expect(box).not.toBeNull();
  expect(dot).not.toBeNull();
  if (box === null || dot === null) return;
  expect(Math.round(box.height / lineHeight), "the long name does not take two lines").toBe(2);
  expect(Math.abs(dot.y + dot.height / 2 - (box.y + lineHeight / 2)), "the dot is not on the name's first line").toBeLessThanOrEqual(1);
});

test("the activity log does not repeat a line's campaign beside its campaign column; Home keeps it, in quotes", async ({ page }) => {
  await page.goto("/activity");
  const lines = page.getByTestId("activity-line");
  await expect(lines.first()).toBeVisible();
  const repeats = await lines.evaluateAll((els) =>
    els.flatMap((el) => {
      const message = el.children[1]?.textContent ?? "";
      const campaign = el.children[2]?.textContent ?? "";
      return campaign !== "" && message.includes(campaign) ? [message] : [];
    }),
  );
  expect(repeats, "a line names the campaign its row already shows").toEqual([]);
  await page.getByLabel("Campaign").selectOption({ label: "Restaurants, Naples" });
  await expect(lines.filter({ has: page.getByText("Paused by you.", { exact: true }) })).toContainText("Restaurants, Naples");
  // Home shows no campaign beside its lines, so a line keeps the campaign's name, in quotes like every other.
  await page.goto("/");
  const home = page.getByRole("region", { name: "What the app did" });
  await expect(home.getByRole("listitem").first()).toBeVisible();
  for (const text of await home.getByRole("listitem").allInnerTexts()) expect(text).not.toMatch(/Campaign [^"]/);
});

test("every line in the activity log and on Home ends as a sentence, whether the app rewrote it or passed it through", async ({ page }) => {
  await page.goto("/activity");
  const lines = page.getByTestId("activity-line");
  await expect(lines.first()).toBeVisible();
  const logged = await lines.evaluateAll((els) => els.map((el) => (el.children[1]?.textContent ?? "").trim()));
  expect(logged.length).toBeGreaterThan(5);
  expect(logged.filter((line) => !/[.!?…]$/.test(line)), "lines without a full stop").toEqual([]);
  expect(logged.filter((line) => /\.\.$/.test(line)), "lines with two full stops").toEqual([]);
  await page.goto("/");
  const home = page.getByRole("region", { name: "What the app did" }).getByRole("listitem");
  await expect(home.first()).toBeVisible();
  const said = await home.evaluateAll((els) => els.map((el) => (el.children[1]?.textContent ?? "").trim()));
  expect(said.filter((line) => !/[.!?…]$/.test(line)), "Home lines without a full stop").toEqual([]);
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

  // A campaign's people: one short block per person (name with score and Profile, headline, stage, reason) that
  // keeps every cell of the table's row, nothing hidden sideways in the box, and an opened person's texts inside the screen.
  await page.goto("/campaigns/1");
  const person = page.getByTestId("prospect-row").first();
  await expect(person.getByRole("rowheader")).toHaveCount(1);
  await expect(person.getByRole("cell")).toHaveCount(6);
  await expect(person.getByTestId("prospect-stage")).toBeVisible();
  const profile = await person.getByRole("link", { name: /^Profile/ }).boundingBox();
  expect((profile?.x ?? Infinity) + (profile?.width ?? 0), "the Profile link runs past the screen").toBeLessThanOrEqual(390);
  const block = await person.boundingBox();
  expect(block?.height ?? Infinity, "a person's block is a stack of labelled rows again").toBeLessThanOrEqual(200);
  const hidden = await page.getByTestId("people-table").evaluate((table) => (table.parentElement === null ? 0 : table.parentElement.scrollWidth - table.parentElement.clientWidth));
  expect(hidden, "the People box scrolls sideways").toBeLessThanOrEqual(0);
  // The name line keeps its right side for the score and Profile; the headline under it runs the block's full width.
  const long = page.getByTestId("prospect-row").filter({ hasText: "Revenue manager at Gruppo Ospitalità Test" });
  const longBlock = await long.boundingBox();
  const longHeader = await long.getByRole("rowheader").boundingBox();
  expect(longBlock?.height ?? Infinity, "a long headline wraps beside the score and Profile").toBeLessThanOrEqual(150);
  expect(longHeader?.width ?? 0, "the name and headline do not span the block").toBeGreaterThanOrEqual((longBlock?.width ?? Infinity) - 2 * 16 - 1);
  const nameButton = await long.getByRole("button").first().boundingBox();
  const chip = await long.getByLabel(/^Score /).boundingBox();
  const longProfile = await long.getByRole("link", { name: /^Profile/ }).boundingBox();
  expect((nameButton?.x ?? Infinity) + (nameButton?.width ?? 0), "the name runs under the score").toBeLessThanOrEqual(chip?.x ?? 0);
  expect((chip?.x ?? Infinity) + (chip?.width ?? 0), "the score runs under Profile").toBeLessThanOrEqual(longProfile?.x ?? 0);
  for (const [what, box] of [["the name", nameButton], ["Profile", longProfile]] as const) expect(box?.height ?? 0, `${what} is too small to tap`).toBeGreaterThanOrEqual(44);
  // In the block the headline is muted and the stage Ink, so the stage line reads as the stage (Test Person 10 is invited).
  const invited = page.getByTestId("prospect-row").filter({ hasText: "Owner at Hotel Modello Centro" });
  await expect(invited.getByRole("rowheader").locator("p").first()).toHaveCSS("color", MUTED);
  await expect(invited.getByTestId("prospect-stage").locator("span").first()).toHaveCSS("color", INK);
  await person.getByRole("button").first().click();
  const detailRight = await page.getByTestId("prospect-detail").evaluate((detail) => detail.getBoundingClientRect().right - window.innerWidth);
  expect(detailRight, "an opened person's texts run past the screen").toBeLessThanOrEqual(0);

  // A person who replied is the best outcome: in Ink, while a rejected person steps back in the muted tone.
  const stageColour = (name: string) => page.getByTestId("prospect-row").filter({ hasText: name }).getByTestId("prospect-stage").locator("span").first();
  await expect(stageColour("Hotel Navona Test")).toHaveText("Stopped (they replied)");
  await expect(stageColour("Hotel Navona Test")).toHaveCSS("color", INK);
  await expect(stageColour("Catena Alberghiera Esempio")).not.toHaveCSS("color", INK);

  // Messages and timings, stacked: each label sits 2px over its value, and 12px under the value before it.
  const pairs = await page
    .getByTestId("messages-list")
    .evaluate((list) => [...list.children].map((child) => ({ tag: child.tagName, top: child.getBoundingClientRect().top, bottom: child.getBoundingClientRect().bottom })));
  for (const [index, item] of pairs.entries()) {
    const next = pairs[index + 1];
    if (next === undefined) continue;
    const gap = next.top - item.bottom;
    if (item.tag === "DT") expect(Math.abs(gap - 2), "a label is not 2px over its value").toBeLessThanOrEqual(1);
    else expect(Math.abs(gap - 12), "a value is not 12px over the next label").toBeLessThanOrEqual(1);
  }

  // Stats: one block per campaign, nothing hidden sideways.
  await page.goto("/stats");
  await expect(page.getByTestId("stats-row").first().getByText("Median time to accept", { exact: true })).toBeVisible();
  const statsHidden = await page.getByTestId("stats-table").evaluate((table) => (table.parentElement === null ? 0 : table.parentElement.scrollWidth - table.parentElement.clientWidth));
  expect(statsHidden, "the Stats box scrolls sideways").toBeLessThanOrEqual(0);
  // The two measures on a line put their values level, even when one name ("Replies seen before the follow-up") takes two lines.
  const valueTops = await page
    .getByTestId("stats-row")
    .first()
    .getByRole("cell")
    .evaluateAll((cells) => cells.slice(0, 2).map((cell) => cell.children[1]?.getBoundingClientRect().top ?? Number.NaN));
  expect(Math.abs((valueTops[0] ?? 0) - (valueTops[1] ?? Infinity)), "the values of a pair of measures sit at different heights").toBeLessThanOrEqual(1);
  // A large figure and the small sentence or count beside it share a baseline.
  const hotelValues = await baselines(page.getByTestId("stats-row").filter({ hasText: "Hotel owners, Rome" }).getByTestId("stat-value"));
  expect(hotelValues).toHaveLength(4);
  expect(Math.abs((hotelValues[0] ?? 0) - (hotelValues[1] ?? Infinity)), "the first pair of values is off the baseline").toBeLessThanOrEqual(0.5);
  expect(Math.abs((hotelValues[2] ?? 0) - (hotelValues[3] ?? Infinity)), "the second pair of values is off the baseline").toBeLessThanOrEqual(0.5);

  // Activity: the Campaign filter's label and its select wrap to a line together.
  await page.goto("/activity");
  const campaignLabel = await page.locator("label").filter({ hasText: /^Campaign$/ }).boundingBox();
  const campaignSelect = await page.getByLabel("Campaign").boundingBox();
  const middle = (box: { y: number; height: number } | null) => (box === null ? Number.NaN : box.y + box.height / 2);
  expect(Math.abs(middle(campaignLabel) - middle(campaignSelect)), "the Campaign label and its select are on different lines").toBeLessThanOrEqual(2);

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
const MUTED = "rgb(91, 98, 93)";
/** Hairline Sage (base-300), the edge of the secondary button. */
const HAIRLINE = "rgb(220, 224, 216)";
const CONTROL = "rgb(129, 134, 131)";
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

  // A touch screen reader has a labelled control inside the menu to close it: a 44px "Close menu" button.
  await button.click();
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link", { name: "Home" })).toBeFocused();
  const close = sidebar(page).getByRole("button", { name: "Close menu" });
  const closeBox = await close.boundingBox();
  expect(closeBox?.width ?? 0, "Close menu is too small to tap").toBeGreaterThanOrEqual(44);
  expect(closeBox?.height ?? 0, "Close menu is too small to tap").toBeGreaterThanOrEqual(44);
  await close.click();
  await expect(nav).toBeHidden();
  await expect(button).toBeFocused();

  await button.click();
  await expect(nav).toBeVisible();
  // The overlay is the strip to the right of the 16rem menu.
  await page.mouse.click(370, 400);
  await expect(nav).toBeHidden();
  await expect(button).toBeFocused();
});

/** For each log line: how far its time sits from its message's first line, and how tall the time is against one line. */
async function timeOffsets(lines: ReturnType<Page["locator"]>) {
  return lines.evaluateAll((items) =>
    items.map((item) => {
      const [time, message] = [item.children[0], item.children[1]];
      if (time === undefined || message === undefined) throw new Error("A log line has no time or no message");
      const lineHeight = Number.parseFloat(getComputedStyle(message).lineHeight);
      const timeBox = time.getBoundingClientRect();
      const messageBox = message.getBoundingClientRect();
      const mark = time.querySelector('[data-testid="level-mark"]')?.getBoundingClientRect();
      return {
        wrapped: messageBox.height > lineHeight * 1.5,
        top: Math.abs(timeBox.top - messageBox.top),
        height: timeBox.height - lineHeight,
        // The mark's middle against the middle of the message's first line; 0 when the line has no mark.
        mark: mark === undefined ? 0 : Math.abs(mark.top + mark.height / 2 - (messageBox.top + lineHeight / 2)),
      };
    }),
  );
}

test("the log's time and level mark sit on a wrapped message's first line, at every width", async ({ page }) => {
  const check = (offsets: Awaited<ReturnType<typeof timeOffsets>>, where: string) => {
    for (const line of offsets) {
      expect(line.top, `${where}: a time is not on its message's first line`).toBeLessThanOrEqual(1);
      expect(line.height, `${where}: a time is taller than one line`).toBeLessThanOrEqual(1);
      expect(line.mark, `${where}: a level mark is not in the middle of the first line`).toBeLessThanOrEqual(1);
    }
  };
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(appUrl("stop"));
    const home = page.getByRole("region", { name: "What the app did" }).getByRole("listitem");
    await expect(home.first()).toBeVisible();
    const homeOffsets = await timeOffsets(home);
    // At 1024 the section runs the page's full width and every line fits on one; the stop line wraps at 390 and 1440.
    if (width !== 1024) expect(homeOffsets.some((line) => line.wrapped), `Home at ${width}: the stop line no longer wraps, so nothing is tested`).toBe(true);
    check(homeOffsets, `Home at ${width}`);

    // Below 640px the activity log puts the time on its own line above the message.
    if (width < 640) continue;
    await page.goto(appUrl("stop", "/activity"));
    const lines = page.getByTestId("activity-line");
    await expect(lines.first()).toBeVisible();
    check(await timeOffsets(lines), `Activity at ${width}`);
  }
});

// The tests on the stop app that need its stop come before the one that resumes it.
test("campaigns during a safety stop: the header says only how many campaigns there are, and Pause stays a bordered button", async ({ page }) => {
  await page.goto(appUrl("stop", "/campaigns"));
  const statuses = () => page.getByTestId("campaigns-table").getByTestId("campaign-status").allInnerTexts();
  await expect(page.getByTestId("campaign-row").first()).toBeVisible();
  const shown = await statuses();
  const halted = shown.filter((status) => status === "Stopped by safety stop").length;
  expect(halted).toBeGreaterThan(1);
  // The red banner right above already says everything is stopped, and the table says which: the header does not repeat it.
  await expect(page.getByTestId("page-aside")).toHaveText(`${shown.length}\u00a0campaigns`);
  // Pause on a halted campaign steps back (muted words) but stays a bordered button beside Archive's plain text.
  const pause = page.getByTestId("campaign-row").getByRole("button", { name: /^Pause / }).first();
  await expect(pause).toHaveCSS("color", MUTED);
  await expect(pause).toHaveCSS("border-top-style", "solid");
  await expect(pause).toHaveCSS("border-top-color", HAIRLINE);
});

test("during a safety stop nothing promises work at a time: Campaigns, a campaign's page, its people and Approve all", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(appUrl("stop", "/campaigns"));
  const trades = page.getByTestId("campaign-row").filter({ has: page.getByRole("link", { name: "Local trades, Milan", exact: true }) });
  // Only what stays true either way: when LinkedIn's limit resets, never when finding people resumes.
  await expect(trades).toContainText(/LinkedIn’s monthly search limit is reached\. It resets on 1\s\w+\s\d{4}\./);
  await expect(page.getByTestId("campaigns-table").first()).not.toContainText(/resumes|looks again|tomorrow/);

  // A campaign's people with a planned step, one later today and one already due: both wait for the resume.
  const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const due = new Date(Date.now() - 3_600_000).toISOString();
  await page.route(
    (url) => /^\/api\/campaigns\/\d+\/prospects$/.test(url.pathname),
    async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { items: Record<string, unknown>[] };
      // The first two wait on the app; the third waits for the user's approval, the fourth for the user's review.
      const items = json.items.map((item, index) =>
        index === 0 ? { ...item, stage: "invited", nextActionAt: later }
        : index === 1 ? { ...item, stage: "accepted", nextActionAt: due }
        : index === 2 ? { ...item, stage: "pending_approval", nextActionAt: later }
        : index === 3 ? { ...item, stage: "needs_review", nextActionAt: later }
        : { ...item, nextActionAt: null },
      );
      await route.fulfill({ response, json: { ...json, items } });
    },
  );
  await trades.getByRole("link", { name: "Local trades, Milan", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Local trades, Milan");
  await expect(page.getByText(/^LinkedIn’s monthly search limit is reached\. It resets on 1\s\w+\s\d{4}\.$/)).toBeVisible();
  await expect(page.getByText(/It resumes on|looks again/)).toHaveCount(0);
  const when = page.getByTestId("people-table").getByTestId("next-action-when");
  await expect(when).toHaveCount(2);
  expect(await when.allInnerTexts()).toEqual(["After you resume", "After you resume"]);
  // A person who waits on the user's own decision is not waiting for the resume: nothing planned, as outside a stop.
  const rows = page.getByTestId("people-table").getByTestId("prospect-row");
  for (const index of [2, 3]) await expect(rows.nth(index).getByRole("cell", { name: "Nothing planned" })).toHaveCount(1);
  await expect(page.getByTestId("people-table")).not.toContainText(/due now|today at|tomorrow at/);
  // Pause on the halted campaign is the bordered secondary button with muted words, as on Home and Campaigns.
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toHaveCSS("color", MUTED);
  await expect(pause).toHaveCSS("border-top-style", "solid");
  await expect(pause).toHaveCSS("border-top-color", HAIRLINE);

  // Approve all: the invites go out once the user resumes, not by themselves.
  await page.goto(appUrl("stop", "/approvals"));
  await page.getByRole("button", { name: /^Approve all \d+ shown$/ }).click();
  const dialog = page.getByRole("dialog", { name: /^Approve all \d+ prospects shown\?$/ });
  await expect(dialog.getByTestId("approve-all-when")).toHaveText("The app sends the invites itself once you resume, within your working window and budgets.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("phone width: the safety-stop banner's icon sits beside its heading, centred on its first line", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appUrl("stop"));
  const banner = page.getByTestId("safety-stop");
  const heading = banner.getByText("Safety stop. All LinkedIn activity is stopped.");
  await expect(heading).toBeVisible();
  const icon = await banner.locator("svg").first().boundingBox();
  const text = await heading.boundingBox();
  const lineHeight = await heading.evaluate((p) => Number.parseFloat(getComputedStyle(p).lineHeight));
  expect(icon).not.toBeNull();
  expect(text).not.toBeNull();
  if (icon === null || text === null) return;
  expect(icon.x + icon.width, "the icon is left of the heading").toBeLessThanOrEqual(text.x);
  expect(Math.abs(icon.y + icon.height / 2 - (text.y + lineHeight / 2)), "the icon is centred on the heading's first line").toBeLessThanOrEqual(1);
  const resume = await banner.getByRole("button", { name: "Resume" }).boundingBox();
  expect(resume?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("the safety-stop banner says what to do, and Resume asks first", async ({ page }) => {
  // The log's stop line leads with "Safety stop:" and no "Error:" before it; a red dot marks it, and a warning line a ring.
  await page.goto(appUrl("stop", "/activity"));
  const stopLine = page.getByTestId("activity-line").filter({ hasText: "Safety stop:" });
  await expect(stopLine).toHaveCount(1);
  await expect(stopLine).not.toContainText("Error:");
  await expect(stopLine.getByTestId("level-mark")).toHaveClass(/status-error/);
  const warning = page.locator('[data-testid="activity-line"][data-level="warning"]').first();
  // A warning's mark is a drawn triangle, not the ring that means Draft, Paused or Finished as a campaign status.
  const warningMark = warning.getByTestId("level-mark");
  expect(await warningMark.evaluate((mark) => mark.tagName.toLowerCase())).toBe("svg");
  await expect(warningMark).not.toHaveClass(/status/);
  await expect(warningMark).toHaveCSS("color", INK);
  await expect(page.locator('[data-testid="activity-line"][data-level="info"]').first().getByTestId("level-mark")).toHaveCount(0);
  // An info line's text starts where a warning line's does.
  const starts = await page
    .getByTestId("activity-line")
    .evaluateAll((lines) => [...new Set(lines.map((line) => Math.round(line.children[1]?.getBoundingClientRect().left ?? Number.NaN)))]);
  expect(starts, "the log lines' texts do not start at one edge").toHaveLength(1);

  await page.goto(appUrl("stop"));

  const banner = page.getByTestId("safety-stop");
  await expect(banner).toContainText("Safety stop. All LinkedIn activity is stopped.");
  await expect(banner).toContainText("LinkedIn is asking for a security check.");
  await expect(banner).toContainText("What to do: Complete LinkedIn’s check in the app’s window, then press Resume.");
  await expect(page.getByRole("region", { name: "Campaigns" })).toContainText("Stopped by safety stop");
  // The red session card leads with the stop; the window's state is one plain secondary line, never an all-clear light.
  const card = sidebar(page).getByTestId("session-status").locator("xpath=..");
  await expect(card).toHaveText(/^The dedicated window is still logged in\. (Last checked \d\d:\d\d|Never checked)\.$/);
  await expect(sidebar(page).locator(".status-success")).toHaveCount(0);

  // Nothing runs until the user resumes, so a spent budget says only when it resets, never that work resumes.
  const spent = page.getByTestId("usage-discovery_page");
  await expect(spent).toContainText(/Budget spent; it resets (tomorrow|today|\w+day|\d+\s\w+)\s\d\d:\d\d/);
  await expect(spent).not.toContainText("resumes");
  // Pause on a campaign the stop has halted steps back but stays a bordered button.
  const pause = page.getByRole("region", { name: "Campaigns" }).getByRole("button", { name: /^Pause / }).first();
  await expect(pause).toHaveCSS("color", MUTED);
  await expect(pause).toHaveCSS("border-top-style", "solid");
  await expect(pause).toHaveCSS("border-top-color", HAIRLINE);

  await banner.getByRole("button", { name: "Resume" }).click();
  const dialog = page.getByRole("dialog", { name: "Resume LinkedIn activity?" });
  await expect(dialog).toContainText("Before you resume: Complete LinkedIn’s check in the app’s window, then press Resume.");
  await dialog.getByRole("button", { name: "Not yet" }).click();
  await expect(dialog).toBeHidden();
  await expect(banner).toBeVisible();

  await banner.getByRole("button", { name: "Resume" }).click();
  await dialog.getByRole("button", { name: "I have done this, resume" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Campaigns" })).not.toContainText("Stopped by safety stop");
  const home = (await (await page.request.get(appUrl("stop", "/api/home"))).json()) as { safetyStop: unknown };
  expect(home.safetyStop).toBeNull();
  // After the resume the caption keeps its one form.
  await expect(spent).toContainText(/Budget spent; it resets /);
  await expect(spent).not.toContainText("resumes");
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

  await expect(page.getByTestId("session-status")).toHaveText("Logged in");
  await expect(recheck).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await sidebar(page).getByRole("link", { name: "Approval queue" }).click();
  await expect(page.getByText("The approval queue is empty.")).toBeVisible();
  // Nobody waits and no filter is set: the empty state alone, with no filters and no dead button.
  await expect(page.getByRole("button", { name: /^Approve all/ })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Minimum score" })).toHaveCount(0);
});

test("a checkpoint shows the red banner with what to do", async ({ page }) => {
  await page.goto(appUrl("checkpoint"));

  await expect(page.getByTestId("session-status")).toHaveText("Checkpoint");
  const banner = page.getByRole("alert");
  await expect(banner).toContainText("LinkedIn needs you.");
  await expect(banner).toContainText("LinkedIn is asking for a security check in the dedicated window");
  await expect(banner.getByRole("button", { name: "Re-check" })).toBeVisible();
});

// ------------------------------------------------------------ council review, round 6

test("needs review: after a decision the focus moves to the next person, and to the empty state when nobody is left", async ({ page }) => {
  // The browser test plays the app: the resolves are answered here, so the demo's held people stay for other tests.
  const resolved = new Set<unknown>();
  await page.route("**/api/home", async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { needsYou: { needsReview: number } };
    await route.fulfill({ response, json: { ...json, needsYou: { ...json.needsYou, needsReview: Math.max(0, json.needsYou.needsReview - resolved.size) } } });
  });
  await page.route(
    (url) => url.pathname === "/api/review",
    async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { total: number; items: Record<string, unknown>[] };
      const items = json.items.filter((item) => !resolved.has(item["id"]));
      await route.fulfill({ response, json: { ...json, total: items.length, items } });
    },
  );
  let held: Record<string, unknown>[] = [];
  await page.route(
    (url) => /^\/api\/prospects\/\d+\/resolve$/.test(url.pathname),
    async (route) => {
      const id = Number(/(\d+)\/resolve$/.exec(new URL(route.request().url()).pathname)?.[1]);
      resolved.add(id);
      const item = held.find((i) => i["id"] === id);
      await route.fulfill({ json: { prospect: { ...item, stage: "stopped", reviewReason: null } } });
    },
  );
  // The stop app: the demo app's held people are decided by the test above.
  held = ((await (await page.request.get(appUrl("stop", "/api/review?pageSize=100"))).json()) as { items: Record<string, unknown>[] }).items;
  expect(held.length).toBeGreaterThanOrEqual(2);

  await page.goto(appUrl("stop", "/review"));
  const items = page.getByTestId("review-item");
  await expect(items).toHaveCount(held.length);
  for (let left = held.length; left > 0; left -= 1) {
    const first = items.first();
    await first.getByRole("radio", { name: "Stop the sequence: nothing more is sent" }).check();
    await first.getByRole("button", { name: "Confirm" }).click();
    await expect(items).toHaveCount(left - 1);
    if (left > 1) await expect(items.first()).toBeFocused();
  }
  await expect(page.getByTestId("review-empty")).toBeFocused();
});

test("approval queue: when the last row is decided, the focus moves to the empty state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Two people in the list; the decisions are answered here, so the demo's queue stays for other tests.
  const decided = new Set<unknown>();
  let shown: Record<string, unknown>[] = [];
  await page.route(
    (url) => url.pathname === "/api/approvals",
    async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { total: number; items: Record<string, unknown>[] };
      shown = json.items.slice(0, 2);
      const items = shown.filter((item) => !decided.has(item["id"]));
      await route.fulfill({ response, json: { ...json, total: items.length, items } });
    },
  );
  await page.route(
    (url) => /^\/api\/prospects\/\d+\/(approve|reject)$/.test(url.pathname),
    async (route) => {
      const id = Number(/(\d+)\/(approve|reject)$/.exec(new URL(route.request().url()).pathname)?.[1]);
      decided.add(id);
      await route.fulfill({ json: { prospect: { ...shown.find((i) => i["id"] === id), stage: "approved" } } });
    },
  );
  await page.goto("/approvals");
  const rows = page.getByTestId("approval-row");
  await expect(rows).toHaveCount(2);
  await rows.nth(1).getByRole("button", { name: "Reject" }).click();
  // The last row left: the focus goes to the row before it.
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("a");
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId("queue-empty")).toBeFocused();
});

test("the session light agrees with the banner: red whenever LinkedIn needs you, a ring when not checked yet", async ({ page }) => {
  const light = () => sidebar(page).getByTestId("session-status").locator("xpath=preceding-sibling::span[1]");
  // Logged out: the red "LinkedIn needs you" bar, and the red dot.
  await page.route("**/api/home", async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { session: Record<string, unknown> };
    await route.fulfill({ response, json: { ...json, session: { ...json.session, status: "logged_out", lastCheckedAt: new Date().toISOString() } } });
  });
  await page.goto("/");
  await expect(page.getByTestId("session-problem")).toContainText("LinkedIn needs you.");
  await expect(sidebar(page).getByTestId("session-status")).toHaveText("Logged out");
  await expect(light()).toHaveClass(/status-error/);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // Not checked yet: no banner, and the hollow ring of something that is not working.
  await page.route("**/api/home", async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { session: Record<string, unknown> };
    await route.fulfill({ response, json: { ...json, session: { ...json.session, status: "unknown", lastCheckedAt: null } } });
  });
  await page.reload();
  await expect(sidebar(page).getByTestId("session-status")).toHaveText("Not checked yet");
  await expect(page.getByTestId("session-problem")).toHaveCount(0);
  await expect(light()).toHaveClass(/status-hollow/);
});
