import { expect, test, type Page, type Request } from "@playwright/test";

// A route handler that re-fetches a response can still be running when its test ends (the dashboard
// polls). Let such a handler finish or fail quietly instead of failing a test that already passed.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

// Campaigns, the wizard, campaign detail, activity log, stats and settings, on the seeded demo app
// (fake driver, engine off; see playwright.config.ts). Nothing here touches LinkedIn or a real AI:
// the AI test route is always answered by the browser test itself (page.route).
// Every text typed below is test input invented here, not product copy.

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const row = (page: Page, name: string) => page.getByTestId("campaign-row").filter({ has: page.getByRole("link", { name, exact: true }) });

test("create a campaign through the wizard, see what blocks the start, fix it and start it", async ({ page }) => {
  const name = "Test campaign from the wizard";
  await page.goto("/campaigns");
  await page.getByRole("link", { name: "New campaign" }).click();
  await expect(page).toHaveURL(/\/campaigns\/new$/);

  // 1. Name. The draft is created here and the address moves to it. The name field has the focus when the wizard opens.
  await expect(page.getByLabel("Campaign name")).toBeFocused();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText("Give the campaign a name")).toBeVisible();
  await page.getByLabel("Campaign name").fill(name);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/campaigns\/\d+\/edit$/);
  // The keyboard and a screen reader land on the new step's heading.
  await expect(page.getByRole("heading", { name: "Where people come from" })).toBeFocused();
  const id = Number(/\/campaigns\/(\d+)\/edit/.exec(page.url())?.[1]);

  // 2. A people search with an address that is not one.
  await page.getByText("People searches").click();
  await expect(page.getByText(/It must start with\s+https:\/\/www\.linkedin\.com\/search\/results\/people\//)).toBeVisible();
  await page.getByLabel("Search address 1").fill("https://linkedin.com/search/results/people/?keywords=test");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // The review while Who fits is empty: the step's own number in its circle, as on the strip, and "(not finished)"; the
  // missing text in Ink at 500, and no red before Start.
  await page.getByRole("navigation", { name: "Wizard steps" }).getByRole("button", { name: "Review and start" }).click();
  const whoFits = page.getByTestId("review-step-3");
  await expect(whoFits.getByRole("heading", { name: "Who fits (not finished)" })).toBeVisible();
  await expect(whoFits.getByTestId("review-mark")).toHaveText("3");
  await expect(whoFits.getByTestId("review-mark")).toHaveClass(/bg-base-300/);
  // A plain sentence by Start says which steps are not finished, and Start points at it.
  const unfinished = page.getByTestId("start-unfinished");
  await expect(unfinished).toHaveText("Who fits and Messages are not finished yet.");
  await expect(unfinished).not.toHaveClass(/text-(error|warning|accent)/);
  await expect(page.getByRole("button", { name: "Start the campaign" })).toHaveAccessibleDescription("Who fits and Messages are not finished yet.");
  await expect(whoFits.getByText("Not written yet")).toHaveCSS("font-weight", "500");
  await expect(whoFits.locator(".status-error, .text-error")).toHaveCount(0);
  // A row named like its step ("Name" under "Name", "Who fits" under "Who fits") keeps its label for screen readers only.
  await expect(page.getByTestId("review-step-1").locator("dt")).toHaveClass(/sr-only/);
  await expect(whoFits.locator("dt")).toHaveClass(/sr-only/);
  await expect(page.getByTestId("review-step-2").locator("dt").first()).not.toHaveClass(/sr-only/);
  await page.getByRole("button", { name: "Change Who fits" }).click();

  // 3. Who fits: an empty box with guidance, no example text.
  const brief = page.getByLabel("Who fits this campaign, and who does not");
  await expect(brief).toHaveValue("");
  await expect(brief).not.toHaveAttribute("placeholder", /.+/);
  await brief.fill("Test targeting: invented founders of invented companies.");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 4. Approval: auto-approve is off and warns when turned on.
  const auto = page.getByRole("switch", { name: "Auto-approve" });
  await expect(auto).not.toBeChecked();
  await auto.check();
  await expect(page.getByText(/^With auto-approve on, the app invites and messages everyone/)).toBeVisible();
  await auto.uncheck();
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 5. Messages: every field starts empty; a chip inserts a variable; the preview names the problem.
  const note = page.getByLabel(/^Invite note/);
  const first = page.getByLabel(/^First message/);
  const followUp = page.getByLabel(/^Follow-up/);
  for (const box of [note, first, followUp]) await expect(box).toHaveValue("");
  await note.fill("test note for ");
  await page.getByRole("button", { name: "Insert First name" }).click();
  await expect(note).toHaveValue("test note for {{first_name}}");
  // The counter beside the note is the template's own length; the 300 belongs to the filled-in text, in the preview.
  await expect(page.getByTestId("note-count")).toHaveText("Template: 28 characters");
  await first.fill("test first message {{first_name}} {{nickname}}");
  const preview = page.getByTestId("preview");
  await expect(preview).toContainText("test note for Anna");
  await expect(preview).toContainText("18 of 300 characters");
  // What the variables filled in is set apart, as in the approval queue.
  await expect(preview.getByTestId("sent-text").first().locator(".font-medium")).toHaveText(["Anna"]);
  await expect(preview).toContainText("{{nickname}} is not a variable");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 6. Timings, then the review.
  await expect(page.getByText(/those budgets are shared by all campaigns/)).toBeVisible();
  await page.getByRole("button", { name: "Save and review" }).click();
  await page.getByRole("button", { name: "Start the campaign" }).click();
  await expect(page.getByTestId("start-error")).toContainText("The campaign cannot start yet");
  await expect(page.getByTestId("start-error")).toContainText("Fix Where people come from and Messages, marked below");
  await expect(page.getByTestId("start-error")).toBeFocused();
  await expect(page.getByTestId("review-step-2")).toContainText("This is not a LinkedIn people search");
  await expect(page.getByTestId("review-step-5")).toContainText("{{nickname}} is not a variable");
  // Its values start with a capital, as their neighbours do.
  await expect(page.getByTestId("review-step-6")).toContainText("Every day counts");

  // The problems show next to their fields too. Fix them there.
  await page.getByRole("button", { name: "Change Where people come from" }).click();
  await expect(page.getByTestId("field-error")).toContainText("This is not a LinkedIn people search");
  await page.getByLabel("Search address 1").fill("https://www.linkedin.com/search/results/people/?keywords=test");
  await expect(page.getByTestId("field-error")).toHaveCount(0);
  await page.getByRole("button", { name: "Messages" }).click();
  await expect(page.getByTestId("field-error")).toContainText("{{nickname}} is not a variable");
  await page.getByLabel(/^First message/).fill("test first message {{first_name}}");
  await expect(page.getByTestId("preview")).toContainText("test first message Anna");
  await page.getByRole("button", { name: "Review and start" }).click();
  await page.getByRole("button", { name: "Start the campaign" }).click();

  await expect(page).toHaveURL(new RegExp(`/campaigns/${id}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page.getByTestId("campaign-status")).toHaveText("Finding people");

  await sidebar(page).getByRole("link", { name: "Campaigns", exact: true }).click();
  await expect(row(page, name).getByTestId("campaign-status")).toHaveText("Finding people");
  const saved = (await (await page.request.get(`/api/campaigns/${id}`)).json()) as { campaign: { inviteNote: string; sourceUrls: string[] } };
  expect(saved.campaign.inviteNote).toBe("test note for {{first_name}}");
  expect(saved.campaign.sourceUrls).toEqual(["https://www.linkedin.com/search/results/people/?keywords=test"]);
});

const OLD_TEXT = "test older first message {{first_name}}";
const NEW_TEXT = "test newer first message {{first_name}}";

/** A new draft through the first four steps, ending on Messages. Returns its id. */
async function draftToMessages(page: Page, name: string): Promise<number> {
  await page.goto("/campaigns/new");
  await page.getByLabel("Campaign name").fill(name);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/campaigns\/\d+\/edit$/);
  const id = Number(/\/campaigns\/(\d+)\/edit/.exec(page.url())?.[1]);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByLabel("Who fits this campaign, and who does not").fill("Test targeting: invented owners of invented companies.");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { name: "Approval" })).toBeVisible();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
  return id;
}

const campaignPath = (url: URL) => /^\/api\/campaigns\/\d+$/.test(url.pathname);

test("wizard: an autosave held on its way never overwrites newer text; Start starts what the review showed", async ({ page }) => {
  const id = await draftToMessages(page, "Test campaign for the save order");

  // Hold the background save of the older text for two seconds before it reaches the app.
  let seen: (request: Request) => void = () => undefined;
  const heldRequest = new Promise<Request>((resolve) => (seen = resolve));
  let held = false;
  await page.route(campaignPath, async (route) => {
    const request = route.request();
    const body = request.method() === "PATCH" ? (request.postDataJSON() as Record<string, unknown>) : {};
    if (held || body["firstMessage"] !== OLD_TEXT) return route.fallback();
    held = true;
    seen(request);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fallback();
  });

  await page.getByLabel(/^First message/).fill(OLD_TEXT);
  const old = await heldRequest;
  await page.getByLabel(/^First message/).fill(NEW_TEXT);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("button", { name: "Save and review" }).click();
  await expect(page.getByTestId("review-step-5")).toContainText("test newer first message {{first_name}}");
  await page.getByRole("button", { name: "Start the campaign" }).click();
  await expect(page).toHaveURL(new RegExp(`/campaigns/${id}$`), { timeout: 10_000 });

  // Whatever the held save did, it has landed by now.
  await old.response();
  const saved = (await (await page.request.get(`/api/campaigns/${id}`)).json()) as { campaign: { status: string; firstMessage: string } };
  expect(saved.campaign.status).toBe("finding");
  expect(saved.campaign.firstMessage).toBe(NEW_TEXT);
});

test("wizard: Start refuses when the app kept other text than the review shows", async ({ page }) => {
  const id = await draftToMessages(page, "Test campaign for the start check");
  await page.getByLabel(/^First message/).fill(NEW_TEXT);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("button", { name: "Save and review" }).click();

  // The browser test changes the app's answer to the save Start makes: it claims other text was kept.
  await page.route(campaignPath, async (route) => {
    const request = route.request();
    const body = request.method() === "PATCH" ? (request.postDataJSON() as Record<string, unknown>) : {};
    if (!("name" in body && "firstMessage" in body)) return route.fallback();
    const response = await route.fetch();
    const json = (await response.json()) as { campaign: Record<string, unknown> };
    await route.fulfill({ response, json: { ...json, campaign: { ...json.campaign, firstMessage: "test text the app kept" } } });
  });
  let startSent = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/campaigns/${id}/start`) startSent = true;
  });

  await page.getByRole("button", { name: "Start the campaign" }).click();
  await expect(page.getByTestId("start-error")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/campaigns/${id}/edit$`));
  expect(startSent).toBe(false);
  const saved = (await (await page.request.get(`/api/campaigns/${id}`)).json()) as { campaign: { status: string } };
  expect(saved.campaign.status).toBe("draft");
});

test("campaigns: funnel counts follow the engine by themselves, without a click or a reload", async ({ page }) => {
  // The engine sends an invite: nothing the page keys its reload on (status, people waiting) changes,
  // only a funnel count. Once the test says so, the answers carry 100 more invited for one campaign.
  let invitedMore = false;
  await page.route(
    (url) => url.pathname === "/api/campaigns",
    async (route) => {
      const response = await route.fetch();
      if (!invitedMore) return route.fulfill({ response });
      const json = (await response.json()) as { campaigns: { name: string; funnel: Record<string, number> }[] };
      const campaigns = json.campaigns.map((c) => (c.name === "Architects, Turin" ? { ...c, funnel: { ...c.funnel, invited: (c.funnel["invited"] ?? 0) + 100 } } : c));
      return route.fulfill({ response, json: { ...json, campaigns } });
    },
  );
  await page.goto("/campaigns");
  const turin = row(page, "Architects, Turin");
  await expect(turin).toBeVisible();
  const cells = turin.locator("td.\\@funnel\\:table-cell");
  const before = Number(await cells.nth(2).innerText());
  invitedMore = true;
  await expect(cells.nth(2)).toHaveText(String(before + 100), { timeout: 25_000 });
});

test("campaigns: the header counts the campaigns at work as active, as the table's words do", async ({ page }) => {
  const summary = page.getByText(/^\d+ campaigns?, \d+ (active|stopped by safety stop)$/);
  const statuses = () => page.getByTestId("campaigns-table").getByTestId("campaign-status").allInnerTexts();

  await page.goto("/campaigns");
  await expect(page.getByTestId("campaign-row").first()).toBeVisible();
  const shown = await statuses();
  const working = shown.filter((status) => ["Finding people", "Waiting for approval", "Running"].includes(status)).length;
  expect(working, "the demo has more than one campaign at work").toBeGreaterThan(1);
  await expect(summary).toHaveText(`${shown.length} campaigns, ${working} active`);
});

test("campaigns: pause and resume, a waiting discovery, and archive after a confirm", async ({ page }) => {
  await page.goto("/campaigns");
  const hotels = row(page, "Hotel owners, Rome");
  await hotels.getByRole("button", { name: "Pause Hotel owners, Rome" }).click();
  await expect(hotels.getByTestId("campaign-status")).toHaveText("Paused");
  await hotels.getByRole("button", { name: "Resume Hotel owners, Rome" }).click();
  await expect(hotels.getByTestId("campaign-status")).toHaveText("Running");

  await expect(row(page, "Local trades, Milan")).toContainText(/LinkedIn's monthly search limit is reached\. It resumes on 1 \w+ \d{4}\./);
  await expect(row(page, "Restaurants, Naples")).toContainText("there is nobody more to find");

  const draft = row(page, "Dentists, Bologna");
  await expect(draft.getByRole("link", { name: "Continue setting up" })).toBeVisible();
  await draft.getByRole("button", { name: "Archive Dentists, Bologna" }).click();
  const dialog = page.getByRole("dialog", { name: "Archive Dentists, Bologna?" });
  await expect(dialog).toContainText("This cannot be undone.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(row(page, "Dentists, Bologna")).toHaveCount(1);
  await draft.getByRole("button", { name: "Archive Dentists, Bologna" }).click();
  await dialog.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByTestId("campaigns-table").first().getByRole("link", { name: "Dentists, Bologna" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show 1" }).click();
  await expect(row(page, "Dentists, Bologna").getByTestId("campaign-status")).toHaveText("Archived");
});

test("a recommendations campaign with nobody new today says it looks again tomorrow", async ({ page }) => {
  // The browser test sets the wait on Home's answer; the rest is the app's own.
  await page.route("**/api/home", async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { campaigns: { name: string; discoveryWait: unknown }[] };
    const campaigns = json.campaigns.map((c) =>
      c.name === "Architects, Turin" ? { ...c, discoveryWait: { reason: "no_new_people", until: null, message: "test message" } } : c,
    );
    await route.fulfill({ response, json: { ...json, campaigns } });
  });
  await page.goto("/campaigns");
  const sentence = "Finding people is waiting: LinkedIn's recommendations show nobody new today. The app looks again tomorrow.";
  await expect(row(page, "Architects, Turin")).toContainText(sentence);
  await row(page, "Architects, Turin").getByRole("link", { name: "Architects, Turin", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Architects, Turin");
  await expect(page.getByText(sentence)).toBeVisible();
});

test("edit a live campaign's follow-up: a bad variable is refused, then the edit is saved", async ({ page }) => {
  await page.goto("/");
  await sidebar(page).getByRole("link", { name: "Hotel owners, Rome" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hotel owners, Rome");

  await page.getByRole("button", { name: "Edit messages and timings" }).click();
  const form = page.getByTestId("live-edit");
  await expect(form).toContainText("Edits apply only to steps not yet sent.");
  const followUp = form.getByLabel(/^Follow-up/);
  await followUp.fill("test follow-up {{oops}}");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form.getByTestId("field-error")).toContainText("{{oops}} is not a variable");

  await followUp.fill("test follow-up for {{first_name}}");
  await expect(form.getByTestId("field-error")).toHaveCount(0);
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved. Edits apply only to steps not yet sent; texts already sent stay as they were.")).toBeVisible();
  await expect(page.getByTestId("current-follow-up")).toHaveText("test follow-up for {{first_name}}");
});

test("campaign detail: the people table pages, filters by stage, and opens a person", async ({ page }) => {
  await page.goto("/");
  await sidebar(page).getByRole("link", { name: "Architects, Turin" }).click();
  await expect(page.getByTestId("funnel")).toContainText("30Found");

  const rows = page.getByTestId("prospect-row");
  await expect(rows).toHaveCount(25);
  await expect(page.getByTestId("pager-range")).toHaveText("Showing 1 to 25 of 30");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(rows).toHaveCount(5);
  await expect(page.getByTestId("pager-range")).toHaveText("Showing 26 to 30 of 30");

  await page.getByLabel("Stage").selectOption({ label: "Rejected" });
  await expect(rows).toHaveCount(10);
  await expect(page.getByTestId("pager-range")).toHaveText("Showing 1 to 10 of 10");
  for (const stage of await rows.getByTestId("prospect-stage").allInnerTexts()) expect(stage).toBe("Rejected");
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);

  // Open a person: texts as sent, history, and the do-not-contact switch.
  const person = rows.first();
  const name = await person.getByRole("button").first().innerText();
  await person.getByRole("button", { name }).click();
  const detail = page.getByTestId("prospect-detail");
  await expect(detail).toContainText("Texts as sent");
  await expect(detail).toContainText("Not invited yet.");
  await expect(detail.getByRole("listitem").filter({ hasText: "Found" })).toBeVisible();
  await expect(detail.getByRole("listitem").filter({ hasText: "Rejected" })).toBeVisible();
  await expect(detail).not.toContainText("Turned down");

  const dnc = detail.getByRole("switch", { name: "Do not contact" });
  await dnc.check();
  await expect(person).toContainText("Do not contact");
  const flagged = (await (await page.request.get(`/api/campaigns/4/prospects?stage=rejected&pageSize=200`)).json()) as {
    items: { person: { fullName: string; doNotContact: boolean } }[];
  };
  expect(flagged.items.find((p) => p.person.fullName === name)?.person.doNotContact).toBe(true);
  await page.getByTestId("prospect-detail").getByRole("switch", { name: "Do not contact" }).uncheck();
  await expect(person).not.toContainText("Do not contact");
});

test("campaign detail: a narrow People table drops the Company column for the eye, so rows stay two or three lines", async ({ page }) => {
  const rows = page.getByTestId("prospect-row");
  const companyWidth = () => page.getByTestId("people-table").getByRole("columnheader", { name: "Company" }).evaluate((th) => th.getBoundingClientRect().width);
  const tallest = () => rows.evaluateAll((els) => Math.max(...els.map((el) => el.getBoundingClientRect().height)));

  // 1280: the table form in a box just past its width. Company stays for screen readers, header and cells together.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/campaigns/1");
  await expect(rows).toHaveCount(20);
  await expect(page.getByTestId("people-table").getByRole("columnheader", { name: "Stage" })).toBeVisible();
  expect(await companyWidth(), "the Company column shows in a narrow table").toBeLessThanOrEqual(1);
  const cellWidths = await rows.evaluateAll((els) => els.map((el) => el.querySelectorAll('[role="cell"]')[0]?.getBoundingClientRect().width ?? 0));
  expect(Math.max(...cellWidths), "a company cell shows without its header").toBeLessThanOrEqual(1);
  expect(await tallest(), "a People row runs past three lines at 1280").toBeLessThanOrEqual(89);

  // 1440: every column, and no row taller than before (two lines, or three when a headline wraps).
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(companyWidth).toBeGreaterThan(40);
  expect(await tallest(), "a People row runs past three lines at 1440").toBeLessThanOrEqual(89);
});

test("campaign detail: the Next action column shows only when someone on the shown page has a next action", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = page.getByTestId("prospect-row");
  const header = page.getByTestId("people-table").getByRole("columnheader", { name: "Next action" });
  const headerWidth = () => header.evaluate((th) => th.getBoundingClientRect().width);
  // The cells of the column: Company, Stage, Score, the reason, Next action, Profile.
  const cellWidths = () => rows.evaluateAll((els) => els.map((el) => el.querySelectorAll('[role="cell"]')[4]?.getBoundingClientRect().width ?? 0));

  // Earlier tests change the demo app's people, so the browser test answers with its own next actions: none, then one.
  let withOne = false;
  const at = new Date(Date.now() + 26 * 3_600_000).toISOString();
  await page.route(
    (url) => url.pathname === "/api/campaigns/1/prospects",
    async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { items: Record<string, unknown>[] };
      const items = json.items.map((item, index) => ({ ...item, nextActionAt: withOne && index === 0 ? at : null }));
      await route.fulfill({ response, json: { ...json, items } });
    },
  );

  // Nobody on this page has a next action: the column is for screen readers only, header and cells together.
  await page.goto("/campaigns/1");
  await expect(rows).toHaveCount(20);
  expect(await headerWidth(), "an empty Next action column shows").toBeLessThanOrEqual(1);
  expect(Math.max(...(await cellWidths())), "a Next action cell shows without its header").toBeLessThanOrEqual(1);
  await expect(rows.first().getByRole("cell", { name: "Nothing planned" })).toHaveCount(1);

  // The first person has a next action: the column shows.
  withOne = true;
  await page.reload();
  await expect(rows).toHaveCount(20);
  await expect.poll(headerWidth).toBeGreaterThan(40);
  expect(Math.min(...(await cellWidths()))).toBeGreaterThan(40);
});

test("activity log: warnings and errors only, and one campaign", async ({ page }) => {
  await page.goto("/activity");
  const lines = page.getByTestId("activity-line");
  await expect(lines.first()).toBeVisible();
  await expect(page.getByText(/Times are in Europe\/Rome/)).toBeVisible();

  await page.getByRole("button", { name: "Warnings and errors" }).click();
  await expect(lines.filter({ hasText: "needs review" }).first()).toBeVisible();
  await expect(page.locator('[data-testid="activity-line"][data-level="info"]')).toHaveCount(0);
  for (const level of await lines.evaluateAll((els) => els.map((el) => el.getAttribute("data-level")))) expect(["warning", "error"]).toContain(level);

  await page.getByLabel("Campaign").selectOption({ label: "Local trades, Milan" });
  await expect(lines.filter({ hasText: "needs review" })).toHaveCount(1);
  await expect(lines.filter({ hasText: "Hotel owners, Rome" })).toHaveCount(0);
  // A spent budget is quiet: its line is information, not a warning.
  await expect(lines.filter({ hasText: "Discovery waits" })).toHaveCount(0);

  await page.getByRole("button", { name: "Everything" }).click();
  await expect(lines.filter({ hasText: "Discovery waits" })).toHaveAttribute("data-level", "info");
  await page.getByLabel("Campaign").selectOption({ label: "Architects, Turin" });
  await expect(lines).toHaveCount(2);
  await expect(lines.filter({ hasText: "Found 30 people in your recommendations" })).toHaveCount(1);
});

test("stats: the labels, rates and Not enough data yet", async ({ page }) => {
  await page.goto("/stats");
  const table = page.getByTestId("stats-table");
  await expect(table.getByRole("columnheader", { name: "Replies seen before the follow-up", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Median time to accept" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Invites withdrawn" })).toBeVisible();

  const hotels = page.getByTestId("stats-row").filter({ hasText: "Hotel owners, Rome" });
  // Other tests in this run change the seeded numbers (a held prospect put back as invited), so the
  // row is checked against what the API says now, not against the seed.
  const stats = (await (await page.request.get("/api/stats")).json()) as {
    campaigns: { name: string; invitesSent: number; accepted: number; acceptanceRate: number }[];
  };
  const row = stats.campaigns.find((campaign) => campaign.name === "Hotel owners, Rome");
  if (row === undefined) throw new Error("the seeded campaign is missing from /api/stats");
  expect(row.invitesSent).toBeGreaterThanOrEqual(10);
  await expect(hotels).toContainText(`${Math.round(row.acceptanceRate * 100)}%`);
  await expect(hotels).toContainText(`${row.accepted} of ${row.invitesSent} invited`);
  await expect(hotels).toContainText("30 hours");
  // One reply out of four first messages: too few for a percentage.
  await expect(hotels.getByTestId("not-enough")).toHaveText("Not enough data yet");
  await expect(hotels).toContainText("1 of 4 messaged");
  await expect(page.getByTestId("stats-row").filter({ hasText: "Architects, Turin" }).getByTestId("not-enough")).toHaveCount(2);

  // In the table, the large figures and the small sentence and count beside them share one baseline.
  const lines = await hotels.getByTestId("stat-value").evaluateAll((values) =>
    values.map((value) => {
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      value.prepend(probe);
      const top = probe.getBoundingClientRect().top;
      probe.remove();
      return top;
    }),
  );
  expect(lines).toHaveLength(4);
  expect(Math.max(...lines) - Math.min(...lines), "the values of a row are off one baseline").toBeLessThanOrEqual(0.5);
});

test("settings: the dedicated window section says the session state, when it was checked, and how to log in again", async ({ page }) => {
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Dedicated window" });
  await expect(section.getByTestId("linkedin-window-state")).toHaveText("Logged in");
  await expect(section.getByTestId("linkedin-window-checked")).toHaveText(/^(Last checked (today|yesterday|on .+) at \d\d:\d\d|Never checked)\.$/);
  await expect(section).toContainText("log in again in the app\u2019s own Chrome window, not in your usual browser, then press Re-check.");

  const recheck = section.getByRole("button", { name: "Re-check" });
  await recheck.click();
  await expect(recheck).toBeEnabled();
  await expect(section.getByTestId("linkedin-window-state")).toHaveText("Logged in");
  await expect(section.getByTestId("linkedin-window-checked")).toHaveText(/^Last checked today at \d\d:\d\d\.$/);
});

test("settings: a failed first load says so in words, tries again by itself, and has a button to try again", async ({ page }) => {
  let failures = 2;
  let asked = 0;
  await page.route(
    (url) => url.pathname === "/api/settings",
    (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      asked += 1;
      if (failures <= 0) return route.fallback();
      failures -= 1;
      return route.fulfill({ status: 500, json: { error: "test: settings unavailable" } });
    },
  );

  // Two failures, then the app answers: the page appears without a click.
  await page.goto("/settings");
  await expect(page.getByText("Could not load the settings: test: settings unavailable")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save settings" })).toBeVisible({ timeout: 10_000 });
  expect(asked).toBe(3);

  // It keeps failing: the error stays, and Try again loads it once the app answers.
  failures = 1_000;
  await page.reload();
  await expect(page.getByText("Could not load the settings: test: settings unavailable")).toBeVisible();
  failures = 0;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Save settings" })).toBeVisible();
  await expect(page.getByText("Could not load the settings")).toHaveCount(0);
});

test("settings: a refused save shows the problem in place, a good one saves; AI test and backups", async ({ page }) => {
  // The AI test never reaches a real AI from a browser test.
  await page.route("**/api/ai/test", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({
      json: { ok: true, provider: "claude_cli", model: "test-model", elapsedMs: 1500, message: "The AI answered in 1.5 s: test answer." },
    });
  });
  await page.goto("/settings");
  await expect(page.getByText("What you do by hand on LinkedIn also counts.")).toBeVisible();

  await expect(page.getByRole("heading", { name: "The app on this Mac" })).toBeVisible();

  // A number that is not one: refused before it is sent, and the focus goes to the field.
  const invites = page.getByLabel("Invites per day");
  await invites.fill("many");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByTestId("settings-result")).toHaveText("Some settings need attention. They are marked.");
  await expect(invites).toBeFocused();
  await expect(invites).toBeInViewport();

  await page.getByLabel("End of the working day").fill("08:00");
  await invites.fill("-1");
  await page.getByLabel("End of the working day").focus();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByTestId("settings-result")).toHaveText("Nothing was saved: some settings are not valid. They are marked.");
  await expect(page.getByText("Enter 0 or more.")).toBeVisible();
  // Refused by the app: the focus goes to the first field it marked, in sight.
  await expect(invites).toBeFocused();
  await expect(invites).toBeInViewport();

  await page.getByLabel("Invites per day").fill("12");
  await page.getByRole("button", { name: "Save settings" }).click();
  // The check across fields arrives once each field is valid.
  await expect(page.getByText("The end must be after the start.")).toBeVisible();

  await page.getByLabel("End of the working day").fill("17:30");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByTestId("settings-result")).toHaveText("Settings saved.");
  const saved = (await (await page.request.get("/api/settings")).json()) as { workingHours: { end: string }; limits: { invitesPerDay: number } };
  expect(saved.workingHours.end).toBe("17:30");
  expect(saved.limits.invitesPerDay).toBe(12);
  await expect(sidebar(page)).toContainText("09:00 to 17:30");

  // The AI test shows its progress, then the answer.
  await page.getByRole("button", { name: "Test the AI", exact: true }).click();
  await expect(page.getByText(/Asking the AI a small question/)).toBeVisible();
  await expect(page.getByTestId("ai-test-result")).toContainText("The AI answered in 1.5 s: test answer.");

  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByTestId("backup-result")).toHaveText(/Backed up to app-\d{4}-\d\d-\d\d\.db\.|is already there\./);
  await expect(page.getByTestId("backups")).toContainText(/app-\d{4}-\d\d-\d\d\.db/);
  // The restore command is folded away for the user's AI coding tool.
  await page.getByTestId("restore-help").getByText("For your AI coding tool").click();
  await expect(page.getByText("npm run restore --")).toBeVisible();
  await expect(page.getByTestId("service-state")).not.toBeEmpty();
  await expect(page.getByRole("link", { name: "Download all prospects (CSV)" })).toHaveAttribute("href", "/api/export/prospects.csv");

  // Put the hours back for the tests that follow.
  await page.getByLabel("End of the working day").fill("18:00");
  await page.getByLabel("Invites per day").fill("15");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByTestId("settings-result")).toHaveText("Settings saved.");
});

test("wizard on a phone: the step strip shows whole steps at its left edge, the current one in full", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const created = (await (await page.request.post("/api/campaigns", { data: { name: "Test strip campaign" } })).json()) as { campaign: { id: number } };
  await page.goto(`/campaigns/${created.campaign.id}/edit`);
  const strip = page.getByRole("navigation", { name: "Wizard steps" }).locator("ol");
  const opened = Number(/^Step (\d) of 7/.exec(await page.getByText(/^Step \d of 7:/).innerText())?.[1]);
  for (let at = opened; at > 1; at -= 1) {
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByText(new RegExp(`^Step ${at - 1} of 7:`))).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Name", exact: true })).toBeVisible();

  for (let step = 1; step <= 7; step += 1) {
    await expect(page.getByText(new RegExp(`^Step ${step} of 7:`))).toBeVisible();
    const items = await strip.evaluate((ol) => {
      const box = ol.getBoundingClientRect();
      return [...ol.querySelectorAll(":scope > li:not([aria-hidden])")].map((li) => {
        const r = li.getBoundingClientRect();
        return { left: r.left - box.left, right: r.right - box.left, current: li.querySelector('[aria-current="step"]') !== null, width: box.width };
      });
    });
    const current = items.findIndex((item) => item.current);
    const here = items[current];
    expect(here, `step ${step}: no current step in the strip`).toBeDefined();
    expect(here?.left ?? -1, `step ${step}: the current step starts off the strip`).toBeGreaterThanOrEqual(-1);
    expect(here?.right ?? Infinity, `step ${step}: the current step ends off the strip`).toBeLessThanOrEqual((here?.width ?? 0) + 1);
    for (const [index, item] of items.entries()) {
      expect(item.left < -1 && item.right > 1, `step ${step}: step ${index + 1} is cut at the strip's left edge`).toBe(false);
    }
    if (step < 7) await page.getByRole("button", { name: step === 6 ? "Save and review" : "Save and continue" }).click();
  }

  // The review's definition lists group each label with its value on a phone: 2px under the label, 12px to the next one.
  const pairs = await page
    .getByTestId("review-step-6")
    .locator("dl")
    .evaluate((list) =>
      [...list.querySelectorAll("dt, dd")].map((child) => ({ tag: child.tagName, top: child.getBoundingClientRect().top, bottom: child.getBoundingClientRect().bottom })),
    );
  expect(pairs.length).toBeGreaterThanOrEqual(4);
  for (const [index, item] of pairs.entries()) {
    const next = pairs[index + 1];
    if (next === undefined) continue;
    const gap = next.top - item.bottom;
    if (item.tag === "DT") expect(Math.abs(gap - 2), "a label is not 2px over its value").toBeLessThanOrEqual(1);
    else expect(Math.abs(gap - 12), "a value is not 12px over the next label").toBeLessThanOrEqual(1);
  }
});

test("wizard on a phone: a refused Continue or Start takes the focus and the view to what needs fixing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/campaigns/new");
  await page.getByLabel("Campaign name").fill("Test campaign for the refusals");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/campaigns\/\d+\/edit$/);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { name: "Approval" })).toBeFocused();

  // A refused Continue: the first field the step marked takes the focus, in view.
  const threshold = page.getByLabel("Score threshold, 0 to 10");
  await threshold.fill("not a number");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(threshold).toHaveAttribute("aria-invalid", "true");
  await expect(threshold).toBeFocused();
  await expect(threshold).toBeInViewport();
  await threshold.fill("7");

  // A refused Start, pressed below the review: the summary above it takes the focus and comes into view, naming the steps.
  await page.getByRole("navigation", { name: "Wizard steps" }).getByRole("button", { name: "Review and start" }).click();
  const start = page.getByRole("button", { name: "Start the campaign" });
  await start.scrollIntoViewIfNeeded();
  await start.click();
  const summary = page.getByTestId("start-error");
  await expect(summary).toBeFocused();
  await expect(summary).toBeInViewport({ ratio: 1 });
  await expect(summary).toHaveAttribute("role", "alert");
  await expect(summary).toContainText("Fix Who fits and Messages, marked below, then press Start again.");
});

const INK = "rgb(29, 37, 33)";
const HAIRLINE = "rgb(220, 224, 216)";

test("wizard: a passed step left unfinished has an Ink-edged circle; its error in the review does not repeat the step's name", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/campaigns/new");
  await page.getByLabel("Campaign name").fill("Test strip");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/campaigns\/\d+\/edit$/);
  // Where people come from, Who fits (left empty), Approval, then Messages: step 5.
  for (const next of ["Who fits", "Approval", "Messages"]) {
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByRole("heading", { name: next, level: 2 })).toBeVisible();
  }
  const strip = page.getByRole("navigation", { name: "Wizard steps" });
  const circle = (name: string) => strip.getByRole("button", { name: new RegExp(`^\\d?\\s*${name}`) }).locator("span").first();
  // Passed and unfinished: the number on Hairline Sage with a 1.5px Ink edge, and "not finished" for a screen reader.
  const ring = `${INK} 0px 0px 0px 1.5px inset`;
  const edge = (locator: ReturnType<typeof circle>) => locator.evaluate((el) => getComputedStyle(el).boxShadow);
  await expect.poll(() => edge(circle("Who fits"))).toContain(ring);
  await expect(strip.getByRole("button", { name: /Who fits/ })).toContainText("(not finished)");
  // Not reached yet: as before, no edge.
  expect(await edge(circle("Timings"))).not.toContain("1.5px");
  await expect(strip.getByRole("button", { name: /Timings/ })).not.toContainText("not finished");

  // A refused Start: inside the Who fits block the error does not say "Who fits:" again; the summary names the step.
  await strip.getByRole("button", { name: /Review and start/ }).click();
  await expect.poll(() => edge(page.getByTestId("review-mark").first())).toContain(ring);
  await page.getByRole("button", { name: "Start the campaign" }).click();
  await expect(page.getByTestId("start-error")).toContainText("Who fits");
  const whoFits = page.getByTestId("review-step-3").getByTestId("field-error");
  await expect(whoFits).toHaveCount(1);
  await expect(whoFits).not.toHaveText(/^Who fits:/);
});

test("wizard on a phone: a save that fails with no marked field brings its message into view and focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await draftToMessages(page, "Test failed save");
  await page.getByLabel("First message").fill("Test first message for {{first_name}}");
  await page.route(
    (url) => url.pathname === `/api/campaigns/${id}`,
    async (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 500, json: { error: "Test failure" } }) : route.fallback()),
  );
  const next = page.getByRole("button", { name: "Save and continue" });
  await next.scrollIntoViewIfNeeded();
  await next.click();
  const failed = page.getByTestId("save-error");
  await expect(failed).toContainText("Could not save the draft: Test failure");
  await expect(failed).toBeFocused();
  await expect(failed).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("heading", { name: "Messages", level: 2 })).toBeVisible();
});

test("forms: a field's hint describes its control, after its error when there is one; a marked field shows the error edge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await draftToMessages(page, "Test hints");
  // Messages: a text's hint, and the AI line's instructions with an error from the app.
  await expect(page.getByLabel("First message")).toHaveAccessibleDescription("Sent after they accept your invite.");
  await page.getByRole("switch", { name: "Let the AI write one line for each person" }).check();
  await expect(page.getByRole("switch", { name: "Let the AI write one line for each person" })).toHaveAccessibleDescription(
    "The line goes where you put the AI-written line variable, based only on what their profile says.",
  );
  await page.route(
    (url) => url.pathname === `/api/campaigns/${id}`,
    async (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 400, json: { error: "Not valid", fields: { personalisationInstructions: "Test instructions error" } } })
        : route.fallback(),
  );
  await page.getByRole("button", { name: "Save and continue" }).click();
  const instructions = page.getByLabel("Your instructions for the AI line");
  await expect(instructions).toHaveAttribute("aria-invalid", "true");
  await expect(instructions).toHaveClass(/textarea-error/);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // Approval: the threshold's hint, then its error first and the hint after it.
  await page.getByRole("navigation", { name: "Wizard steps" }).getByRole("button", { name: /Approval/ }).click();
  const threshold = page.getByLabel("Score threshold, 0 to 10");
  const hint = "The lowest score that reaches your approval queue. People who score lower are rejected without asking you.";
  await expect(threshold).toHaveAccessibleDescription(hint);
  await threshold.fill("not a number");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(threshold).toHaveAttribute("aria-invalid", "true");
  const error = await page.getByTestId("field-error").first().innerText();
  await expect(threshold).toHaveAccessibleDescription(`${error} ${hint}`);
  await expect(page.getByRole("switch", { name: "Auto-approve" })).toHaveAccessibleDescription("Off: you approve each person before the app invites them.");
});

test("settings: hints describe their fields, the AI fields show the error edge, and a failed save is said by the Save button", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await expect(page.getByLabel("Invites per day")).toHaveAccessibleDescription("Connection invites sent in a day.");
  await expect(page.getByLabel("Shortest gap in seconds")).toHaveAccessibleDescription("A random wait between two actions on LinkedIn.");
  await expect(page.getByLabel("Model")).toHaveAccessibleDescription("Leave it empty to use the provider’s default.");
  await expect(page.getByLabel("Which AI")).toHaveAccessibleDescription("Claude Code is the claude command on this Mac.");

  // The Budgets card: the cool-down after LinkedIn's own limit stands apart from the allowances, under a hairline and a wider gap.
  const cooldown = page.getByTestId("cooldown-row");
  await expect(cooldown).toContainText("Days invites stay off");
  await expect(cooldown).toHaveCSS("border-top-style", "solid");
  await expect(cooldown).toHaveCSS("border-top-color", HAIRLINE);
  // From one row's last line to the next row's label, against the budgets' last line to the cool-down's label.
  const gaps = await cooldown.evaluate((el) => {
    const rows = [...(el.previousElementSibling?.children ?? [])];
    const textOf = (row: Element | undefined) => [...(row?.querySelectorAll("p") ?? [])].map((p) => p.getBoundingClientRect());
    const before = textOf(rows.at(-2));
    const last = textOf(rows.at(-1));
    const own = textOf(el);
    return { rows: (last[0]?.top ?? 0) - (before.at(-1)?.bottom ?? 0), apart: (own[0]?.top ?? 0) - (last.at(-1)?.bottom ?? 0) };
  });
  expect(gaps.rows).toBeGreaterThan(0);
  expect(gaps.apart, "the cool-down is no further from the budgets than a budget from the next").toBeGreaterThanOrEqual(1.9 * gaps.rows);

  await page.route("**/api/settings", async (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 400, json: { error: "Not valid", fields: { "ai.model": "Test model error", "ai.provider": "Test provider error" } } })
      : route.fallback(),
  );
  await page.getByLabel("Model").fill("test-model");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByLabel("Model")).toHaveClass(/input-error/);
  await expect(page.getByLabel("Which AI")).toHaveClass(/select-error/);
  await expect(page.getByLabel("Model")).toHaveAccessibleDescription("Test model error. Leave it empty to use the provider’s default.");
  // The first marked field takes the focus: Which AI comes before Model.
  await expect(page.getByLabel("Which AI")).toBeFocused();

  // A failure with no marked field is said beside Save, which stays in view at the foot of the window.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/api/settings", async (route) =>
    route.request().method() === "PATCH" ? route.fulfill({ status: 500, json: { error: "Test failure" } }) : route.fallback(),
  );
  await page.getByLabel("Model").fill("test-model-2");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByTestId("settings-result")).toHaveText("Test failure");
  await expect(page.getByTestId("settings-result")).toBeInViewport({ ratio: 1 });
});

test("campaign detail at 1440: an opened person's Do not contact sits under the texts, so no column leaves an empty block", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/campaigns/1");
  const rows = page.getByTestId("prospect-row");
  await rows.first().getByRole("button").first().click();
  const detail = page.getByTestId("prospect-detail");
  const texts = await detail.getByRole("heading", { name: "Texts as sent" }).boundingBox();
  const history = await detail.getByRole("heading", { name: "History" }).boundingBox();
  const card = await detail.getByTestId("dnc-card").boundingBox();
  const lastText = await detail.locator("dl").last().boundingBox();
  const historyList = await detail.getByRole("list").last().boundingBox();
  expect(texts && history && card && lastText && historyList).toBeTruthy();
  if (texts === null || history === null || card === null || lastText === null || historyList === null) return;
  expect(Math.abs(card.x - texts.x), "Do not contact is not in the texts' column").toBeLessThanOrEqual(1);
  expect(card.y).toBeGreaterThan(lastText.y + lastText.height);
  expect(Math.abs(history.y - texts.y), "History is not top-aligned with the texts").toBeLessThanOrEqual(1);
  // The two columns end close together: no block of empty space under either one.
  const left = card.y + card.height;
  const right = historyList.y + historyList.height;
  expect(Math.max(0, right - left), "the History column leaves the texts' column an empty block").toBeLessThanOrEqual(48);

  // On a phone the order is unchanged: texts, history, then Do not contact.
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneHistory = await detail.getByRole("heading", { name: "History" }).boundingBox();
  const phoneCard = await detail.getByTestId("dnc-card").boundingBox();
  expect((phoneCard?.y ?? 0) > (phoneHistory?.y ?? 0), "on a phone Do not contact is not after History").toBe(true);
});
