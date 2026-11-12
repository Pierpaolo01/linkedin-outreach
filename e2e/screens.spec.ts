import { expect, test, type Page } from "@playwright/test";

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

  // 1. Name. The draft is created here and the address moves to it.
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText("Give the campaign a name")).toBeVisible();
  await page.getByLabel("Campaign name").fill(name);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/campaigns\/\d+\/edit$/);
  await expect(page.getByRole("heading", { name: "Where people come from" })).toBeVisible();
  const id = Number(/\/campaigns\/(\d+)\/edit/.exec(page.url())?.[1]);

  // 2. A people search with an address that is not one.
  await page.getByText("People searches").click();
  await expect(page.getByText(/It must start with\s+https:\/\/www\.linkedin\.com\/search\/results\/people\//)).toBeVisible();
  await page.getByLabel("Search address 1").fill("https://linkedin.com/search/results/people/?keywords=test");
  await page.getByRole("button", { name: "Save and continue" }).click();

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
  await expect(page.getByTestId("note-count")).toHaveText("28 / 300");
  await first.fill("test first message {{first_name}} {{nickname}}");
  const preview = page.getByTestId("preview");
  await expect(preview).toContainText("test note for Anna");
  await expect(preview).toContainText("{{nickname}} is not a variable");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 6. Timings, then the review.
  await expect(page.getByText(/those limits are shared by all campaigns/)).toBeVisible();
  await page.getByRole("button", { name: "Save and review" }).click();
  await page.getByRole("button", { name: "Start the campaign" }).click();
  await expect(page.getByTestId("start-error")).toContainText("The campaign cannot start yet");
  await expect(page.getByTestId("review-step-2")).toContainText("This is not a LinkedIn people search");
  await expect(page.getByTestId("review-step-5")).toContainText("{{nickname}} is not a variable");

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
  await expect(lines.filter({ hasText: "Discovery paused" })).toHaveCount(1);
  await expect(lines.filter({ hasText: "Hotel owners, Rome" })).toHaveCount(0);

  await page.getByRole("button", { name: "Everything" }).click();
  await page.getByLabel("Campaign").selectOption({ label: "Architects, Turin" });
  await expect(lines).toHaveCount(2);
  await expect(lines.filter({ hasText: "Found 30 people in your recommendations" })).toHaveCount(1);
});

test("stats: the labels, rates and not enough data yet", async ({ page }) => {
  await page.goto("/stats");
  const table = page.getByTestId("stats-table");
  await expect(table.getByRole("columnheader", { name: "replies seen before the follow-up", exact: true })).toBeVisible();
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
  await expect(hotels.getByTestId("not-enough")).toHaveText("not enough data yet");
  await expect(hotels).toContainText("1 of 4 messaged");
  await expect(page.getByTestId("stats-row").filter({ hasText: "Architects, Turin" }).getByTestId("not-enough")).toHaveCount(2);
});

test("settings: the LinkedIn window section says the session state, when it was checked, and how to log in again", async ({ page }) => {
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "LinkedIn window" });
  await expect(section.getByTestId("linkedin-window-state")).toHaveText("Connected");
  await expect(section.getByTestId("linkedin-window-checked")).toHaveText(/^(Last checked (today|yesterday|on .+) at \d\d:\d\d|Never checked)\.$/);
  await expect(section).toContainText("log in again in the app\u2019s own Chrome window, not in your usual browser, then press Re-check.");

  const recheck = section.getByRole("button", { name: "Re-check" });
  await recheck.click();
  await expect(recheck).toBeEnabled();
  await expect(section.getByTestId("linkedin-window-state")).toHaveText("Connected");
  await expect(section.getByTestId("linkedin-window-checked")).toHaveText(/^Last checked today at \d\d:\d\d\.$/);
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

  await page.getByLabel("End of the working day").fill("08:00");
  await page.getByLabel("Invites per day").fill("-1");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByTestId("settings-result")).toHaveText("Nothing was saved: some settings are not valid. They are marked.");
  await expect(page.getByText("Enter 0 or more.")).toBeVisible();

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
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText(/Asking the AI a small question/)).toBeVisible();
  await expect(page.getByTestId("ai-test-result")).toContainText("The AI answered in 1.5 s: test answer.");

  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByTestId("backup-result")).toHaveText(/Backed up to app-\d{4}-\d\d-\d\d\.db\.|is already there\./);
  await expect(page.getByTestId("backups")).toContainText(/app-\d{4}-\d\d-\d\d\.db/);
  await expect(page.getByText("npm run restore --")).toBeVisible();
  await expect(page.getByTestId("service-state")).not.toBeEmpty();
  await expect(page.getByRole("link", { name: "Download all prospects (CSV)" })).toHaveAttribute("href", "/api/export/prospects.csv");

  // Put the hours back for the tests that follow.
  await page.getByLabel("End of the working day").fill("18:00");
  await page.getByLabel("Invites per day").fill("15");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByTestId("settings-result")).toHaveText("Settings saved.");
});
