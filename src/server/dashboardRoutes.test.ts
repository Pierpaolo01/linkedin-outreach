import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedCampaign, seedPerson, seedPersonProspect, seedProspect } from "../campaigns/testSeed";
import { DEFAULT_SETTINGS, getSettings } from "../config/settings";
import { actions, discoveryRuns, eventLog, safetyStops } from "../db/schema";
import { HOST, NOW, startTestServer, type TestServer } from "./testServer";

const HOUR = 3_600_000;

let s: TestServer;
beforeEach(() => {
  s = startTestServer();
});
afterEach(async () => {
  await s.close();
});

function claimed(type: "invite" | "message" | "profile_view", n: number, at: Date = NOW) {
  for (let i = 0; i < n; i += 1) {
    s.db.insert(actions).values({ type, status: "done", idempotencyKey: `${type}-test-${at.getTime()}-${i}`, attempts: 1, startedAt: at }).run();
  }
}

describe("GET /api/home", () => {
  it("shows the session, no safety stop, today's usage, campaigns and what needs the user", async () => {
    const running = seedCampaign(s.db, { status: "running" });
    seedCampaign(s.db, { name: "Old", status: "archived" });
    seedPersonProspect(s.db, running, 1, "pending_approval");
    seedPersonProspect(s.db, running, 2, "pending_approval");
    seedPersonProspect(s.db, running, 3, "needs_review");
    claimed("message", 10);
    claimed("profile_view", 2);

    const res = await s.get("/api/home");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      session: { status: "unknown", lastCheckedAt: null, lastError: null, checking: false },
      safetyStop: null,
      usage: {
        // Warm-up: the first invite day allows 5.
        invite: { used: 0, limit: 5, open: true, resumesAt: null },
        // Spent: opens again at the next working instant, Tuesday 09:00 in Rome.
        message: { used: 10, limit: 10, open: false, resumesAt: "2026-11-17T08:00:00.000Z" },
        profile_view: { used: 2, limit: 40, open: true, resumesAt: null },
        discovery_page: { used: 0, limit: 10, open: true, resumesAt: null },
        withdraw: { used: 0, limit: 10, open: true, resumesAt: null },
      },
      campaigns: [{ id: running, name: "Test campaign", status: "running", discoveryWait: null }],
      needsYou: { pendingApproval: 2, needsReview: 1 },
    });
  });

  it("shows the active safety stop with what to do", async () => {
    s.db.insert(safetyStops).values({ reason: "checkpoint", detail: "Security check page", raisedAt: new Date(NOW.getTime() - HOUR) }).run();

    const res = await s.get("/api/home");

    expect(res.json().safetyStop).toEqual({
      reason: "checkpoint",
      detail: "Security check page",
      raisedAt: new Date(NOW.getTime() - HOUR).toISOString(),
      whatToDo: "complete LinkedIn's check in the app's window, then press Resume",
      invitesBlockedUntil: null,
    });
  });
});

describe("GET /api/home: is discovery waiting", () => {
  const SEARCH_A = "https://www.linkedin.com/search/results/people/?keywords=founder";
  const SEARCH_B = "https://www.linkedin.com/search/results/people/?keywords=owner";

  function run(campaignId: number, values: Partial<typeof discoveryRuns.$inferInsert>) {
    s.db.insert(discoveryRuns).values({ campaignId, source: "search", sourceUrl: SEARCH_A, createdAt: NOW, updatedAt: NOW, ...values }).run();
  }
  async function waitOf(id: number) {
    const campaigns: { id: number; discoveryWait: unknown }[] = (await s.get("/api/home")).json().campaigns;
    return campaigns.find((c) => c.id === id)?.discoveryWait;
  }

  it("says when LinkedIn's monthly search limit holds discovery, and until when", async () => {
    const until = new Date("2026-11-30T23:00:00Z"); // 1 December in Rome
    const capped = seedCampaign(s.db, { status: "finding", sourceUrls: [SEARCH_A] });
    run(capped, { pausedUntil: until });

    expect(await waitOf(capped)).toEqual({
      reason: "search_limit",
      until: until.toISOString(),
      message: "LinkedIn's monthly search limit; resumes on 2026-12-01",
    });
  });

  it("holds every search campaign while the limit holds, since it is on the account", async () => {
    const until = new Date("2026-11-30T23:00:00Z");
    run(seedCampaign(s.db, { status: "running", sourceUrls: [SEARCH_A] }), { pausedUntil: until });
    const other = seedCampaign(s.db, { status: "finding", sourceUrls: [SEARCH_B] });
    const recommendations = seedCampaign(s.db, { status: "finding", discoverySource: "recommendations", sourceUrls: [] });

    expect(await waitOf(other)).toMatchObject({ reason: "search_limit" });
    expect(await waitOf(recommendations)).toBeNull();
  });

  it("says when every source of the campaign has nobody more to show", async () => {
    const done = seedCampaign(s.db, { status: "running", sourceUrls: [SEARCH_A, SEARCH_B] });
    run(done, { sourceUrl: SEARCH_A, exhausted: true });
    run(done, { sourceUrl: SEARCH_B, exhausted: true });
    const half = seedCampaign(s.db, { status: "running", sourceUrls: [SEARCH_A, SEARCH_B] });
    run(half, { sourceUrl: SEARCH_A, exhausted: true });

    expect(await waitOf(done)).toEqual({ reason: "exhausted", until: null, message: "no more people to find from this source" });
    expect(await waitOf(half)).toBeNull();
  });

  it("says when LinkedIn's suggestions had nobody new today, and that it looks again tomorrow", async () => {
    const tomorrow = new Date("2026-11-16T23:00:00Z"); // 17 November in Rome
    const quiet = seedCampaign(s.db, { status: "running", discoverySource: "recommendations", sourceUrls: [] });
    run(quiet, { source: "recommendations", sourceUrl: null, pausedUntil: tomorrow });
    const yesterday = seedCampaign(s.db, { status: "running", discoverySource: "recommendations", sourceUrls: [] });
    run(yesterday, { source: "recommendations", sourceUrl: null, pausedUntil: new Date(NOW.getTime() - HOUR) });

    expect(await waitOf(quiet)).toEqual({
      reason: "no_new_people",
      until: tomorrow.toISOString(),
      message: "no new people in LinkedIn's suggestions today; looks again tomorrow",
    });
    expect(await waitOf(yesterday)).toBeNull();
  });

  it("is not waiting once the limit has passed, nor for a draft", async () => {
    const past = seedCampaign(s.db, { status: "finding" });
    run(past, { pausedUntil: new Date(NOW.getTime() - HOUR) });
    expect(await waitOf(past)).toBeNull();

    s.db.delete(discoveryRuns).run();
    run(past, { pausedUntil: new Date(NOW.getTime() + HOUR) });
    const draft = seedCampaign(s.db, { status: "draft" });
    expect(await waitOf(draft)).toBeNull();
  });
});

describe("POST /api/safety-stop/resume", () => {
  it("lifts the active safety stop", async () => {
    s.db.insert(safetyStops).values({ reason: "logged_out", raisedAt: NOW }).run();

    const res = await s.send("POST", "/api/safety-stop/resume");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resumed: true });
    expect((await s.get("/api/home")).json().safetyStop).toBeNull();
  });

  it("answers 409 when there is no safety stop", async () => {
    const res = await s.send("POST", "/api/safety-stop/resume");

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "There is no safety stop to resume" });
  });

  it("answers 400 for a body", async () => {
    expect((await s.send("POST", "/api/safety-stop/resume", { force: true })).statusCode).toBe(400);
  });
});

describe("GET /api/activity", () => {
  it("lists the activity log newest first, filtered by campaign and level, paged", async () => {
    const id = seedCampaign(s.db);
    for (let i = 0; i < 3; i += 1) {
      s.db.insert(eventLog).values({ at: new Date(NOW.getTime() + i * 1000), level: "warning", campaignId: id, message: `Warning ${i}` }).run();
    }
    s.db.insert(eventLog).values({ at: NOW, level: "info", campaignId: id, message: "Info" }).run();
    s.db.insert(eventLog).values({ at: NOW, level: "warning", message: "Elsewhere" }).run();

    const res = await s.get(`/api/activity?campaignId=${id}&level=warning&pageSize=2`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ page: 1, pageSize: 2, total: 3, items: [{ message: "Warning 2", level: "warning", campaignId: id }, { message: "Warning 1" }] });
  });

  it("answers 400 for a wrong level and 404 for an unknown campaign", async () => {
    expect((await s.get("/api/activity?level=debug")).json()).toEqual({
      error: "Some fields need attention",
      fields: { level: "Choose one of: info, warning, error" },
    });
    expect((await s.get("/api/activity?campaignId=99")).statusCode).toBe(404);
  });
});

describe("GET /api/actions", () => {
  it("lists the ledger newest first with the person's name, paged", async () => {
    const id = seedCampaign(s.db);
    const { prospectId } = seedPersonProspect(s.db, id, 1, "invited");
    s.db.insert(actions).values({ type: "profile_view", prospectId, campaignId: id, status: "done", idempotencyKey: "view:1", startedAt: NOW }).run();
    s.db.insert(actions).values({ type: "invite", prospectId, campaignId: id, status: "unknown", idempotencyKey: `invite:${prospectId}`, startedAt: NOW, error: "timeout" }).run();
    s.db.insert(actions).values({ type: "connections_check", status: "failed", idempotencyKey: "check:1", startedAt: NOW }).run();

    const first = await s.get("/api/actions?pageSize=2");
    const second = await s.get("/api/actions?pageSize=2&page=2");

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      total: 3,
      items: [
        { type: "connections_check", status: "failed", personName: null },
        { type: "invite", status: "unknown", error: "timeout", personName: "Test Person 1", campaignId: id, prospectId },
      ],
    });
    expect(second.json()).toMatchObject({ items: [{ type: "profile_view" }] });
  });

  it("answers 400 for wrong paging", async () => {
    expect((await s.get("/api/actions?pageSize=0")).statusCode).toBe(400);
  });
});

describe("GET /api/stats", () => {
  it("gives each campaign's acceptance rate, reply rate before the follow-up, median time to accept and withdrawals", async () => {
    const id = seedCampaign(s.db, { status: "running" });
    const invited = (n: number, values: Parameters<typeof seedPersonProspect>[4]) =>
      seedPersonProspect(s.db, id, n, "invited", { approvedAt: NOW, invitedAt: NOW, ...values });
    invited(1, { stage: "accepted", acceptanceObservedAt: new Date(NOW.getTime() + 10 * HOUR) });
    invited(2, { stage: "stopped", acceptanceObservedAt: new Date(NOW.getTime() + 20 * HOUR), firstMessageSentAt: NOW, replyDetectedAt: NOW });
    invited(3, { stage: "completed", acceptanceObservedAt: new Date(NOW.getTime() + 60 * HOUR), firstMessageSentAt: NOW, followUpSentAt: NOW });
    invited(4, { stage: "withdrawn" });
    // A reply seen before any first message does not count toward the reply rate.
    invited(5, { stage: "stopped", acceptanceObservedAt: new Date(NOW.getTime() + 40 * HOUR), replyDetectedAt: NOW });
    const empty = seedCampaign(s.db, { name: "Empty" });

    const res = await s.get("/api/stats");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      campaigns: [
        {
          campaignId: empty,
          name: "Empty",
          status: "draft",
          invitesSent: 0,
          accepted: 0,
          acceptanceRate: null,
          firstMessagesSent: 0,
          replies: 0,
          replyRate: { label: "replies seen before the follow-up", value: null },
          medianHoursToAccept: null,
          invitesWithdrawn: 0,
        },
        {
          campaignId: id,
          name: "Test campaign",
          status: "running",
          invitesSent: 5,
          accepted: 4,
          acceptanceRate: 0.8,
          firstMessagesSent: 2,
          replies: 1,
          replyRate: { label: "replies seen before the follow-up", value: 0.5 },
          medianHoursToAccept: 30,
          invitesWithdrawn: 1,
        },
      ],
    });
  });
});

describe("PATCH /api/settings", () => {
  it("turns keeping the Mac awake off", async () => {
    const res = await s.send("PATCH", "/api/settings", { keepAwake: false });

    expect(res.statusCode).toBe(200);
    expect(getSettings(s.db).keepAwake).toBe(false);
  });

  it("changes some settings, nested groups one field at a time, and returns them all", async () => {
    const res = await s.send("PATCH", "/api/settings", { limits: { invitesPerDay: 12 }, workingHours: { end: "17:00" } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ...DEFAULT_SETTINGS,
      limits: { ...DEFAULT_SETTINGS.limits, invitesPerDay: 12 },
      workingHours: { start: "09:00", end: "17:00" },
    });
    expect(getSettings(s.db).limits.invitesPerDay).toBe(12);
  });

  it("answers 400 with a message per field and stores nothing", async () => {
    const res = await s.send("PATCH", "/api/settings", {
      timeZone: "Mars/Olympus",
      limits: { invitesPerDay: -1, messagesPerDay: 2.5 },
      colour: "red",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Some settings are not valid",
      fields: {
        colour: "Unknown field",
        timeZone: "unknown time zone",
        "limits.invitesPerDay": "Enter 0 or more",
        "limits.messagesPerDay": "Enter a whole number",
      },
    });
    expect(getSettings(s.db)).toEqual(DEFAULT_SETTINGS);
  });

  it("answers 400 when the settings disagree with each other once merged", async () => {
    const res = await s.send("PATCH", "/api/settings", { workingHours: { start: "18:00" } });

    expect(res.json()).toEqual({ error: "Some settings are not valid", fields: { workingHours: "end must be after start" } });
    expect(getSettings(s.db)).toEqual(DEFAULT_SETTINGS);
  });

  it("answers 400 for a wrong type", async () => {
    const res = await s.send("PATCH", "/api/settings", { workingDays: "weekdays", warmUp: { enabled: "yes" } });

    expect(res.json()).toEqual({
      error: "Some settings are not valid",
      fields: { workingDays: "Send a list", "warmUp.enabled": "Send true or false" },
    });
  });
});

describe("GET /api/export/prospects.csv", () => {
  it("exports every campaign's prospects as formula-safe CSV", async () => {
    const id = seedCampaign(s.db, { name: "Founders, Milan" });
    const personId = seedPerson(s.db, 1, { headline: "=HYPERLINK(\"http://evil.example\")", company: 'The "Best" Co' });
    seedProspect(s.db, id, personId, "invited", { invitedAt: NOW, inviteNoteSent: "Hi Test,\nnice to meet you" });

    const res = await s.get("/api/export/prospects.csv");

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="prospects.csv"');
    const [header, row] = res.body.replace(/^\uFEFF/, "").split("\r\n");
    expect(header).toBe(
      "campaign_id,campaign,prospect_id,stage,score,score_reason,full_name,first_name,headline,title,company,location,profile_url,do_not_contact,found_at,approved_at,invited_at,acceptance_observed_at,first_message_sent_at,follow_up_sent_at,reply_detected_at,closed_at,stop_reason,review_reason,invite_note_sent,first_message_sent,follow_up_sent",
    );
    expect(row).toContain(`${id},"Founders, Milan",`);
    expect(row).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(row).toContain('"The ""Best"" Co"');
    expect(res.body).toContain('"Hi Test,\nnice to meet you"');
    expect(res.body.startsWith("\uFEFF")).toBe(true);
  });

  it("exports one campaign", async () => {
    const a = seedCampaign(s.db, { name: "A" });
    const b = seedCampaign(s.db, { name: "B" });
    seedPersonProspect(s.db, a, 1, "found");
    seedPersonProspect(s.db, b, 2, "found");

    const res = await s.get(`/api/export/prospects.csv?campaignId=${b}`);

    expect(res.headers["content-disposition"]).toBe(`attachment; filename="prospects-campaign-${b}.csv"`);
    expect(res.body.trim().split("\r\n")).toHaveLength(2);
    expect(res.body).toContain("Test Person 2");
    expect(res.body).not.toContain("Test Person 1");
  });

  it("answers 404 for an unknown campaign and 400 for a wrong id", async () => {
    expect((await s.get("/api/export/prospects.csv?campaignId=99")).statusCode).toBe(404);
    expect((await s.get("/api/export/prospects.csv?campaignId=x")).statusCode).toBe(400);
  });

  it("refuses a foreign Host", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/export/prospects.csv", headers: { ...HOST, host: "evil.example" } });

    expect(res.statusCode).toBe(403);
  });
});
