/**
 * Routes for campaigns, their prospects, the approval queue, needs review and do not contact. Each
 * validates its input and calls one function in `src/campaigns`, which does the work.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  archiveCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  previewCampaign,
  resumeCampaign,
  startCampaign,
  updateCampaign,
  type CampaignView,
} from "../campaigns/campaigns";
import {
  approvalQueue,
  approveProspect,
  approveShown,
  listProspects,
  rejectProspect,
  resolveReview,
  reviewQueue,
  setDoNotContact,
  type PersonView,
  type ProspectView,
} from "../campaigns/prospects";
import { campaignFieldsSchema } from "../campaigns/rules";
import type { Db } from "../db/index";
import { PROSPECT_STAGES } from "../db/schema";
import { TRANSITIONS } from "../engine/lifecycle";
import { campaignIdQuery, check, idParam, NO_BODY_ERROR, noBody, orEmpty, pagingQuery, sendOutcome } from "./http";

const bool = z.boolean({ error: "Send true or false" });
const SCORE = "Enter a score from 0 to 10";
const minScore = z.coerce.number({ error: SCORE }).min(0, { error: SCORE }).max(10, { error: SCORE });

const startBody = z.strictObject({ confirmAutoApprove: bool.optional() }, { error: "Send a JSON object" });
const previewBody = campaignFieldsSchema.pick({ inviteNote: true, firstMessage: true, followUp: true, aiPersonalise: true });
const prospectsQuery = z.strictObject({
  stage: z.enum(PROSPECT_STAGES, { error: `Choose one of: ${PROSPECT_STAGES.join(", ")}` }).optional(),
  ...pagingQuery,
});
const approvalsQuery = z.strictObject({ campaignId: campaignIdQuery, minScore: minScore.optional(), ...pagingQuery });
/** The most prospects one "approve all" may name: more than a page of the queue holds. */
const MAX_APPROVE_ALL = 500;
const PROSPECT_ID = "Enter a prospect id (a whole number)";
const ID_COUNT = `Send from 1 to ${MAX_APPROVE_ALL} prospect ids`;
/** "Approve all": exactly the prospects the user was shown, each named once. */
const approveAllBody = z.strictObject(
  {
    prospectIds: z
      .array(z.number({ error: PROSPECT_ID }).int({ error: PROSPECT_ID }).min(1, { error: PROSPECT_ID }), { error: "Send the ids of the prospects shown" })
      .min(1, { error: ID_COUNT })
      .max(MAX_APPROVE_ALL, { error: ID_COUNT })
      .refine((ids) => new Set(ids).size === ids.length, { error: "Send each prospect id once" }),
  },
  { error: "Send a JSON object" },
);
const reviewQuery = z.strictObject({ campaignId: campaignIdQuery, ...pagingQuery });
const resolveBody = z.strictObject(
  {
    stage: z.enum(PROSPECT_STAGES, { error: `Choose one of: ${TRANSITIONS.needs_review.join(", ")}` }),
    note: z.string({ error: "Send text" }).max(2_000, { error: "Keep the note to 2000 characters or fewer" }).nullable().optional(),
  },
  { error: "Send a JSON object" },
);
const doNotContactBody = z.strictObject({ doNotContact: bool }, { error: "Send a JSON object" });

const asCampaign = (campaign: CampaignView) => ({ campaign });
const asProspect = (prospect: ProspectView) => ({ prospect });
const asPerson = (person: PersonView) => ({ person });
const same = <T>(value: T) => value;

export function registerCampaignRoutes(app: FastifyInstance, { db, now }: { readonly db: Db; readonly now: () => Date }): void {
  // ------------------------------------------------------------ campaigns

  app.get("/api/campaigns", async () => ({ campaigns: listCampaigns(db) }));

  app.post("/api/campaigns", async (request, reply) => {
    const body = check(campaignFieldsSchema, orEmpty(request.body));
    if (!body.ok) return reply.code(400).send(body.body);
    return reply.code(201).send(asCampaign(createCampaign(db, body.value, now())));
  });

  app.get("/api/campaigns/:id", async (request, reply) => {
    const { id, raw } = idParam(request.params);
    if (id === null) return reply.code(404).send({ error: `No campaign ${raw}` });
    return sendOutcome(reply, getCampaign(db, id), asCampaign);
  });

  app.patch("/api/campaigns/:id", async (request, reply) => {
    const { id, raw } = idParam(request.params);
    if (id === null) return reply.code(404).send({ error: `No campaign ${raw}` });
    const body = check(campaignFieldsSchema, orEmpty(request.body));
    if (!body.ok) return reply.code(400).send(body.body);
    return sendOutcome(reply, updateCampaign(db, id, body.value, now()), same);
  });

  app.post("/api/campaigns/:id/start", async (request, reply) => {
    const { id, raw } = idParam(request.params);
    if (id === null) return reply.code(404).send({ error: `No campaign ${raw}` });
    const body = check(startBody, orEmpty(request.body));
    if (!body.ok) return reply.code(400).send(body.body);
    return sendOutcome(reply, startCampaign(db, id, { confirmAutoApprove: body.value.confirmAutoApprove ?? false }, now()), asCampaign);
  });

  for (const [path, move] of [
    ["pause", pauseCampaign],
    ["resume", resumeCampaign],
    ["archive", archiveCampaign],
  ] as const) {
    app.post(`/api/campaigns/:id/${path}`, async (request, reply) => {
      const { id, raw } = idParam(request.params);
      if (id === null) return reply.code(404).send({ error: `No campaign ${raw}` });
      if (!noBody.safeParse(request.body).success) return reply.code(400).send(NO_BODY_ERROR);
      return sendOutcome(reply, move(db, id, now()), asCampaign);
    });
  }

  app.post("/api/campaigns/:id/preview", async (request, reply) => {
    const { id, raw } = idParam(request.params);
    if (id === null) return reply.code(404).send({ error: `No campaign ${raw}` });
    const body = check(previewBody, orEmpty(request.body));
    if (!body.ok) return reply.code(400).send(body.body);
    return sendOutcome(reply, previewCampaign(db, id, body.value), same);
  });

  app.get("/api/campaigns/:id/prospects", async (request, reply) => {
    const { id, raw } = idParam(request.params);
    if (id === null) return reply.code(404).send({ error: `No campaign ${raw}` });
    const query = check(prospectsQuery, request.query);
    if (!query.ok) return reply.code(400).send(query.body);
    const { stage, ...paging } = query.value;
    return sendOutcome(reply, listProspects(db, id, { stage: stage ?? null, ...paging }), same);
  });

  // ------------------------------------------------------------ approval queue

  app.get("/api/approvals", async (request, reply) => {
    const query = check(approvalsQuery, request.query);
    if (!query.ok) return reply.code(400).send(query.body);
    const { campaignId, minScore: min, ...paging } = query.value;
    return sendOutcome(reply, approvalQueue(db, { campaignId: campaignId ?? null, minScore: min ?? null, ...paging }), same);
  });

  app.post("/api/approvals/approve-all", async (request, reply) => {
    const body = check(approveAllBody, orEmpty(request.body));
    if (!body.ok) return reply.code(400).send(body.body);
    return sendOutcome(reply, approveShown(db, body.value.prospectIds, now()), same);
  });

  for (const [path, decide] of [
    ["approve", approveProspect],
    ["reject", rejectProspect],
  ] as const) {
    app.post(`/api/prospects/:id/${path}`, async (request, reply) => {
      const { id, raw } = idParam(request.params);
      if (id === null) return reply.code(404).send({ error: `No prospect ${raw}` });
      if (!noBody.safeParse(request.body).success) return reply.code(400).send(NO_BODY_ERROR);
      return sendOutcome(reply, decide(db, id, now()), asProspect);
    });
  }

  // ------------------------------------------------------------ needs review

  app.get("/api/review", async (request, reply) => {
    const query = check(reviewQuery, request.query);
    if (!query.ok) return reply.code(400).send(query.body);
    const { campaignId, ...paging } = query.value;
    return sendOutcome(reply, reviewQueue(db, { campaignId: campaignId ?? null, ...paging }), same);
  });

  app.post("/api/prospects/:id/resolve", async (request, reply) => {
    const { id, raw } = idParam(request.params);
    if (id === null) return reply.code(404).send({ error: `No prospect ${raw}` });
    const body = check(resolveBody, orEmpty(request.body));
    if (!body.ok) return reply.code(400).send(body.body);
    return sendOutcome(reply, resolveReview(db, id, { stage: body.value.stage, note: body.value.note ?? null }, now()), asProspect);
  });

  // ------------------------------------------------------------ do not contact

  app.post("/api/people/:id/do-not-contact", async (request, reply) => {
    const { id, raw } = idParam(request.params);
    if (id === null) return reply.code(404).send({ error: `No person ${raw}` });
    const body = check(doNotContactBody, orEmpty(request.body));
    if (!body.ok) return reply.code(400).send(body.body);
    return sendOutcome(reply, setDoNotContact(db, id, body.value.doNotContact, now()), asPerson);
  });
}
