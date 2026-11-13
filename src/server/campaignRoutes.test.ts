import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedCampaign, seedPerson, seedPersonProspect } from "../campaigns/testSeed";
import { actions, campaigns, people, prospects } from "../db/schema";
import { HOST, NOW, PORT, startTestServer, type TestServer } from "./testServer";

let s: TestServer;
beforeEach(() => {
  s = startTestServer();
});
afterEach(async () => {
  await s.close();
});

const stageOf = (id: number) => s.db.select({ stage: prospects.stage }).from(prospects).where(eq(prospects.id, id)).get()?.stage;
const statusOf = (id: number) => s.db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, id)).get()?.status;

describe("Host and Origin checks on the new routes", () => {
  it("refuses a GET with a foreign Host", async () => {
    const res = await s.app.inject({ method: "GET", url: "/api/campaigns", headers: { host: "evil.example" } });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Forbidden host" });
  });

  it("refuses a POST from a foreign Origin and changes nothing", async () => {
    const id = seedCampaign(s.db, { status: "running" });

    const res = await s.app.inject({
      method: "POST",
      url: `/api/campaigns/${id}/pause`,
      headers: { ...HOST, origin: "http://evil.example" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Forbidden origin" });
    expect(statusOf(id)).toBe("running");
  });

  it("accepts a POST from the dashboard's own origin", async () => {
    const id = seedCampaign(s.db, { status: "running" });

    const res = await s.app.inject({
      method: "POST",
      url: `/api/campaigns/${id}/pause`,
      headers: { ...HOST, origin: `http://127.0.0.1:${PORT}` },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe("GET /api/campaigns", () => {
  it("lists campaigns with status and funnel counts", async () => {
    const id = seedCampaign(s.db, { status: "running" });
    seedPersonProspect(s.db, id, 1, "invited", { approvedAt: NOW, invitedAt: NOW });

    const res = await s.get("/api/campaigns");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      campaigns: [{ id, name: "Test campaign", status: "running", funnel: { found: 1, approved: 1, invited: 1, accepted: 0, messaged: 0, replied: 0 } }],
    });
  });
});

describe("POST /api/campaigns", () => {
  it("creates a draft and answers 201 with it", async () => {
    const res = await s.send("POST", "/api/campaigns", { name: "Founders", discoverySource: "search", scoreThreshold: 8 });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ campaign: { name: "Founders", status: "draft", discoverySource: "search", scoreThreshold: 8, createdAt: NOW.toISOString() } });
  });

  it("creates a draft from no body at all", async () => {
    const res = await s.send("POST", "/api/campaigns");

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ campaign: { name: "", status: "draft" } });
  });

  it("answers 400 with a message for each wrong field", async () => {
    const res = await s.send("POST", "/api/campaigns", { name: 3, scoreThreshold: 12, status: "running" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Some fields need attention",
      fields: { name: "Send text", scoreThreshold: "Enter a whole number from 0 to 10", status: "Unknown field" },
    });
  });

  it("answers 400 for a body that is not an object", async () => {
    const res = await s.send("POST", "/api/campaigns", ["x"]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Some fields need attention" });
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await s.app.inject({ method: "POST", url: "/api/campaigns", headers: { ...HOST, "content-type": "application/json" }, payload: "{nope" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });
});

describe("GET /api/campaigns/:id", () => {
  it("reads one campaign", async () => {
    const id = seedCampaign(s.db);

    const res = await s.get(`/api/campaigns/${id}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ campaign: { id, firstMessage: "Thanks for connecting, {{first_name}}." } });
  });

  it.each(["99", "abc", "0", "1.5"])("answers 404 for id %s", async (id) => {
    const res = await s.get(`/api/campaigns/${id}`);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: `No campaign ${id}` });
  });
});

describe("PATCH /api/campaigns/:id", () => {
  it("edits a draft with no notice", async () => {
    const id = seedCampaign(s.db);

    const res = await s.send("PATCH", `/api/campaigns/${id}`, { name: "Renamed" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ campaign: { name: "Renamed" }, notice: null });
  });

  it("edits a live campaign's templates and says edits apply to steps not yet sent", async () => {
    const id = seedCampaign(s.db, { status: "running" });

    const res = await s.send("PATCH", `/api/campaigns/${id}`, { followUp: "Still interested, {{first_name}}?" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ notice: "Saved. Edits apply only to steps not yet sent; texts already sent stay as they were." });
  });

  it("answers 409 for a field a live campaign cannot change", async () => {
    const id = seedCampaign(s.db, { status: "running" });

    const res = await s.send("PATCH", `/api/campaigns/${id}`, { scoringBrief: "Anyone" });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Once a campaign has started only its templates and timings can change. These cannot: scoringBrief" });
  });

  it("answers 400 for a live template the engine could not send", async () => {
    const id = seedCampaign(s.db, { status: "running" });

    const res = await s.send("PATCH", `/api/campaigns/${id}`, { inviteNote: "x".repeat(301) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ fields: { inviteNote: expect.stringMatching(/^The invite note must be at most 200 characters/) } });
  });

  it("answers 400 for a wrong field and 404 for an unknown campaign", async () => {
    const id = seedCampaign(s.db);

    expect((await s.send("PATCH", `/api/campaigns/${id}`, { delayPolicy: "sometimes" })).json()).toEqual({
      error: "Some fields need attention",
      fields: { delayPolicy: "Choose calendar or working_days" },
    });
    expect((await s.send("PATCH", "/api/campaigns/99", { name: "x" })).statusCode).toBe(404);
  });
});

describe("POST /api/campaigns/:id/start", () => {
  it("starts a valid draft", async () => {
    const id = seedCampaign(s.db);

    const res = await s.send("POST", `/api/campaigns/${id}/start`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ campaign: { status: "finding" } });
  });

  it("answers 400 with what to fix before start", async () => {
    const id = seedCampaign(s.db, { discoverySource: "search", sourceUrls: ["https://example.com/people"], openProfileThreshold: 9 });

    const res = await s.send("POST", `/api/campaigns/${id}/start`, {});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "The campaign cannot start yet",
      fields: {
        "sourceUrls.0": "This is not a LinkedIn people search. Copy the address of a search on www.linkedin.com/search/results/people/",
        openProfileThreshold: "The open-profile threshold must not be above the score threshold (7)",
      },
    });
  });

  it("starts with auto-approve on without a confirmation", async () => {
    const id = seedCampaign(s.db, { autoApprove: true });

    const started = await s.send("POST", `/api/campaigns/${id}/start`);

    expect(started.statusCode).toBe(200);
  });

  it("answers 400 for a wrong confirmAutoApprove", async () => {
    const id = seedCampaign(s.db);

    const res = await s.send("POST", `/api/campaigns/${id}/start`, { confirmAutoApprove: "yes" });

    expect(res.json()).toEqual({ error: "Some fields need attention", fields: { confirmAutoApprove: "Send true or false" } });
  });

  it("answers 409 for a campaign that is not a draft", async () => {
    const id = seedCampaign(s.db, { status: "finding" });

    const res = await s.send("POST", `/api/campaigns/${id}/start`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Only a draft can be started; this campaign is finding" });
  });
});

describe("pause, resume and archive", () => {
  it("pauses, resumes to where it was, and archives", async () => {
    const id = seedCampaign(s.db, { status: "awaiting_approval" });

    expect((await s.send("POST", `/api/campaigns/${id}/pause`)).json()).toMatchObject({ campaign: { status: "paused" } });
    expect((await s.send("POST", `/api/campaigns/${id}/resume`)).json()).toMatchObject({ campaign: { status: "awaiting_approval" } });
    expect((await s.send("POST", `/api/campaigns/${id}/archive`)).json()).toMatchObject({ campaign: { status: "archived" } });
  });

  it("answers 409 for moves the campaign's status forbids", async () => {
    const id = seedCampaign(s.db);

    expect((await s.send("POST", `/api/campaigns/${id}/pause`)).statusCode).toBe(409);
    expect((await s.send("POST", `/api/campaigns/${id}/resume`)).statusCode).toBe(409);
    await s.send("POST", `/api/campaigns/${id}/archive`);
    expect((await s.send("POST", `/api/campaigns/${id}/archive`)).json()).toEqual({ error: "This campaign is already archived" });
  });

  it("answers 400 for a body and 404 for an unknown campaign", async () => {
    const id = seedCampaign(s.db, { status: "running" });

    expect((await s.send("POST", `/api/campaigns/${id}/pause`, { now: true })).json()).toEqual({ error: "This endpoint takes no body" });
    expect((await s.send("POST", "/api/campaigns/99/resume")).statusCode).toBe(404);
  });
});

describe("POST /api/campaigns/:id/preview", () => {
  it("renders the saved templates against invented values when nobody is found yet", async () => {
    const id = seedCampaign(s.db);

    const res = await s.send("POST", `/api/campaigns/${id}/preview`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ samples: "invented", items: [{ prospectId: null, firstMessage: { ok: true, text: "Thanks for connecting, Anna." } }] });
  });

  it("renders unsaved templates against real prospects", async () => {
    const id = seedCampaign(s.db);
    const { prospectId } = seedPersonProspect(s.db, id, 1, "pending_approval");

    const res = await s.send("POST", `/api/campaigns/${id}/preview`, { firstMessage: "Ciao {{first_name}} ({{title}})", inviteNote: null });

    expect(res.json()).toEqual({
      samples: "prospects",
      items: [
        {
          prospectId,
          fullName: "Test Person 1",
          inviteNote: null,
          firstMessage: { ok: true, text: "Ciao Test (Founder)", length: 19 },
          followUp: { ok: true, text: "Any thoughts, Test?", length: 19 },
        },
      ],
    });
  });

  it("answers 400 for a field that is not a template", async () => {
    const id = seedCampaign(s.db);

    const res = await s.send("POST", `/api/campaigns/${id}/preview`, { name: "x" });

    expect(res.json()).toEqual({ error: "Some fields need attention", fields: { name: "Unknown field" } });
  });

  it("answers 404 for an unknown campaign", async () => {
    expect((await s.send("POST", "/api/campaigns/99/preview")).statusCode).toBe(404);
  });
});

describe("GET /api/campaigns/:id/prospects", () => {
  it("lists a page of prospects in one stage", async () => {
    const id = seedCampaign(s.db);
    for (let n = 1; n <= 3; n += 1) seedPersonProspect(s.db, id, n, "pending_approval");
    seedPersonProspect(s.db, id, 4, "rejected");

    const res = await s.get(`/api/campaigns/${id}/prospects?stage=pending_approval&page=2&pageSize=2`);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect({ ...body, items: body.items.map((p: { person: { fullName: string } }) => p.person.fullName) }).toEqual({
      page: 2,
      pageSize: 2,
      total: 3,
      items: ["Test Person 3"],
    });
  });

  it("answers 400 for a wrong stage or paging", async () => {
    const id = seedCampaign(s.db);

    const res = await s.get(`/api/campaigns/${id}/prospects?stage=lead&page=0&pageSize=500`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Some fields need attention",
      fields: {
        stage: expect.stringMatching(/^Choose one of: found, scored, /),
        page: "Enter a whole number of 1 or more",
        pageSize: "Enter a whole number from 1 to 200",
      },
    });
  });

  it("answers 404 for an unknown campaign", async () => {
    expect((await s.get("/api/campaigns/99/prospects")).statusCode).toBe(404);
  });
});

describe("approvals", () => {
  it("lists the approval queue filtered by campaign and score", async () => {
    const id = seedCampaign(s.db, { status: "awaiting_approval" });
    seedPersonProspect(s.db, id, 1, "pending_approval", { score: 6.5 });
    seedPersonProspect(s.db, id, 2, "pending_approval", { score: 9 });

    const res = await s.get(`/api/approvals?campaignId=${id}&minScore=7`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      total: 1,
      items: [{ score: 9, person: { fullName: "Test Person 2" }, preview: { firstMessage: { ok: true, text: "Thanks for connecting, Test." } } }],
    });
  });

  it("answers 400 for a wrong filter and 404 for an unknown campaign", async () => {
    expect((await s.get("/api/approvals?minScore=eleven")).json()).toEqual({
      error: "Some fields need attention",
      fields: { minScore: "Enter a score from 0 to 10" },
    });
    expect((await s.get("/api/approvals?campaignId=99")).statusCode).toBe(404);
  });

  it("approves one prospect and starts a campaign awaiting approval", async () => {
    const id = seedCampaign(s.db, { status: "awaiting_approval" });
    const { prospectId } = seedPersonProspect(s.db, id, 1, "pending_approval");

    const res = await s.send("POST", `/api/prospects/${prospectId}/approve`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ prospect: { stage: "approved", approvedAt: NOW.toISOString() } });
    expect(statusOf(id)).toBe("running");
  });

  it("rejects one prospect", async () => {
    const id = seedCampaign(s.db);
    const { prospectId } = seedPersonProspect(s.db, id, 1, "pending_approval");

    const res = await s.send("POST", `/api/prospects/${prospectId}/reject`);

    expect(res.json()).toMatchObject({ prospect: { stage: "rejected" } });
  });

  it("answers 409 for a prospect not waiting, 404 for an unknown one, 400 for a body", async () => {
    const id = seedCampaign(s.db);
    const { prospectId } = seedPersonProspect(s.db, id, 1, "invited");

    expect((await s.send("POST", `/api/prospects/${prospectId}/approve`)).statusCode).toBe(409);
    expect((await s.send("POST", `/api/prospects/${prospectId}/reject`)).statusCode).toBe(409);
    expect((await s.send("POST", "/api/prospects/99/approve")).json()).toEqual({ error: "No prospect 99" });
    expect((await s.send("POST", `/api/prospects/${prospectId}/approve`, { score: 10 })).statusCode).toBe(400);
  });

  it("approves exactly the prospects shown that still wait, and skips the rest", async () => {
    const id = seedCampaign(s.db, { status: "awaiting_approval" });
    const shown = seedPersonProspect(s.db, id, 1, "pending_approval").prospectId;
    const rejectedMeanwhile = seedPersonProspect(s.db, id, 2, "rejected").prospectId;
    // Scored after the list loaded: the user never saw it, so it keeps waiting.
    const notShown = seedPersonProspect(s.db, id, 3, "pending_approval").prospectId;

    const res = await s.send("POST", "/api/approvals/approve-all", { prospectIds: [shown, rejectedMeanwhile, 999] });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ approved: 1, skipped: 2 });
    expect([stageOf(shown), stageOf(rejectedMeanwhile), stageOf(notShown)]).toEqual(["approved", "rejected", "pending_approval"]);
    expect(s.db.select({ at: prospects.approvedAt }).from(prospects).where(eq(prospects.id, shown)).get()?.at).toEqual(NOW);
    expect(statusOf(id)).toBe("running");
  });

  it("approves the shown prospects of several campaigns and starts each campaign awaiting approval", async () => {
    const a = seedCampaign(s.db, { status: "awaiting_approval" });
    const b = seedCampaign(s.db, { status: "awaiting_approval" });
    const inA = seedPersonProspect(s.db, a, 1, "pending_approval").prospectId;
    const inB = seedPersonProspect(s.db, b, 2, "pending_approval").prospectId;

    expect((await s.send("POST", "/api/approvals/approve-all", { prospectIds: [inA, inB] })).json()).toEqual({ approved: 2, skipped: 0 });
    expect([statusOf(a), statusOf(b)]).toEqual(["running", "running"]);
  });

  it("answers 400 for a list that is missing, empty, too long, repeated or not whole numbers, and for the old campaign form", async () => {
    const fields = async (body: unknown) => (await s.send("POST", "/api/approvals/approve-all", body)).json<{ fields?: Record<string, string> }>().fields;
    expect(await fields({})).toEqual({ prospectIds: "Send the ids of the prospects shown" });
    expect(await fields({ prospectIds: [] })).toEqual({ prospectIds: "Send from 1 to 500 prospect ids" });
    expect(await fields({ prospectIds: Array.from({ length: 501 }, (_, i) => i + 1) })).toEqual({ prospectIds: "Send from 1 to 500 prospect ids" });
    expect(await fields({ prospectIds: [3, 4, 3] })).toEqual({ prospectIds: "Send each prospect id once" });
    expect(await fields({ prospectIds: [1, 0, 1.5, "2"] })).toEqual({
      "prospectIds.1": "Enter a prospect id (a whole number)",
      "prospectIds.2": "Enter a prospect id (a whole number)",
      "prospectIds.3": "Enter a prospect id (a whole number)",
    });
    expect(await fields({ campaignId: 1, minScore: 7 })).toMatchObject({ campaignId: "Unknown field", prospectIds: "Send the ids of the prospects shown" });
  });

  it("approves nobody when the body is refused", async () => {
    const id = seedCampaign(s.db, { status: "awaiting_approval" });
    const waiting = seedPersonProspect(s.db, id, 1, "pending_approval").prospectId;

    expect((await s.send("POST", "/api/approvals/approve-all", { prospectIds: [waiting, waiting] })).statusCode).toBe(400);
    expect((await s.send("POST", "/api/approvals/approve-all", { campaignId: id })).statusCode).toBe(400);
    expect(stageOf(waiting)).toBe("pending_approval");
  });
});

describe("needs review", () => {
  it("lists prospects held for review", async () => {
    const id = seedCampaign(s.db);
    seedPersonProspect(s.db, id, 1, "needs_review", { reviewReason: "existing conversation" });
    seedPersonProspect(s.db, id, 2, "needs_review", { reviewReason: "unknown send result" });

    const res = await s.get("/api/review?pageSize=1");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ page: 1, pageSize: 1, total: 2, items: [{ reviewReason: "existing conversation", screenshotPath: null }] });
  });

  it("answers 400 for wrong paging", async () => {
    expect((await s.get("/api/review?page=x")).json()).toEqual({ error: "Some fields need attention", fields: { page: "Enter a whole number of 1 or more" } });
  });

  it("resolves a prospect to a stage the lifecycle allows", async () => {
    const id = seedCampaign(s.db, { status: "running" });
    const { prospectId } = seedPersonProspect(s.db, id, 1, "needs_review");

    const res = await s.send("POST", `/api/prospects/${prospectId}/resolve`, { stage: "invited", note: "Invite is pending on LinkedIn" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ prospect: { stage: "invited", reviewReason: null } });
  });

  it("answers 409 for a stage the lifecycle forbids and 400 for a missing stage", async () => {
    const id = seedCampaign(s.db);
    const { prospectId } = seedPersonProspect(s.db, id, 1, "needs_review");

    expect((await s.send("POST", `/api/prospects/${prospectId}/resolve`, { stage: "found" })).statusCode).toBe(409);
    expect((await s.send("POST", `/api/prospects/${prospectId}/resolve`, { note: "?" })).json()).toEqual({
      error: "Some fields need attention",
      fields: { stage: expect.stringMatching(/^Choose one of: /) },
    });
    expect((await s.send("POST", "/api/prospects/99/resolve", { stage: "rejected" })).statusCode).toBe(404);
  });
});

describe("GET /api/screenshots/:name", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it("serves a PNG from the screenshots folder, never cached", async () => {
    writeFileSync(join(s.screenshotsDir, "2026-11-16T09-00-00-000Z-invite.png"), PNG);

    const res = await s.get("/api/screenshots/2026-11-16T09-00-00-000Z-invite.png");

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it.each([
    ["a missing file", "missing.png"],
    ["another type", "shot.jpg"],
    ["a name with a space", "a%20shot.png"],
    ["a path out of the folder", "..%2Fapp.db"],
    ["a path out of the folder ending in .png", "..%2F..%2Fsecret.png"],
    ["a folder", "folder.png"],
    ["a link out of the folder", "link.png"],
  ])("answers 404 for %s", async (_label, name) => {
    writeFileSync(join(s.screenshotsDir, "..", "secret.png"), PNG);
    mkdirSync(join(s.screenshotsDir, "folder.png"), { recursive: true });
    symlinkSync(join(s.screenshotsDir, "..", "secret.png"), join(s.screenshotsDir, "link.png"));

    const res = await s.get(`/api/screenshots/${name}`);

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).not.toBe("image/png");
  });

  it("answers 403 to another host", async () => {
    writeFileSync(join(s.screenshotsDir, "shot.png"), PNG);
    expect((await s.get("/api/screenshots/shot.png", { host: "evil.example:4747" })).statusCode).toBe(403);
  });

  it("lists the screenshot's address with a prospect in needs review", async () => {
    const id = seedCampaign(s.db, { status: "running" });
    const { prospectId } = seedPersonProspect(s.db, id, 1, "needs_review");
    const path = join(s.screenshotsDir, "shot.png");
    s.db.insert(actions).values({ type: "invite", prospectId, campaignId: id, status: "unknown", idempotencyKey: `invite:${prospectId}`, screenshotPath: path }).run();

    expect((await s.get("/api/review")).json()).toMatchObject({ items: [{ screenshotPath: path, screenshotUrl: "/api/screenshots/shot.png" }] });
  });
});

describe("POST /api/people/:id/do-not-contact", () => {
  it("sets and clears do not contact", async () => {
    const personId = seedPerson(s.db, 1);

    const set = await s.send("POST", `/api/people/${personId}/do-not-contact`, { doNotContact: true });
    const flag = () => s.db.select({ f: people.doNotContact }).from(people).where(eq(people.id, personId)).get()?.f;
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ person: { id: personId, doNotContact: true } });
    expect(flag()).toBe(true);

    await s.send("POST", `/api/people/${personId}/do-not-contact`, { doNotContact: false });
    expect(flag()).toBe(false);
  });

  it("answers 400 without the flag and 404 for an unknown person", async () => {
    const personId = seedPerson(s.db, 1);

    expect((await s.send("POST", `/api/people/${personId}/do-not-contact`, {})).json()).toEqual({
      error: "Some fields need attention",
      fields: { doNotContact: "Send true or false" },
    });
    expect((await s.send("POST", "/api/people/99/do-not-contact", { doNotContact: true })).json()).toEqual({ error: "No person 99" });
  });
});
