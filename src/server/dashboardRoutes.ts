/**
 * Routes for Home, the safety stop, the activity log, the ledger, Stats, Settings and the CSV
 * export. No route starts the engine, the AI or a browser.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FieldProblems } from "../campaigns/rules";
import { fieldProblems } from "../campaigns/rules";
import { getSettings, setSettings, settingsSchema, type SettingsPatch } from "../config/settings";
import type { Db } from "../db/index";
import { EVENT_LEVELS } from "../db/schema";
import { resumeSafetyStop } from "../engine/safetyStop";
import { campaignIdQuery, check, NO_BODY_ERROR, noBody, orEmpty, pagingQuery, sendOutcome } from "./http";
import { activity, exportProspects, home, ledger, stats } from "./reads";
import type { SessionCheck } from "./sessionStore";

const activityQuery = z.strictObject({
  campaignId: campaignIdQuery,
  level: z.enum(EVENT_LEVELS, { error: `Choose one of: ${EVENT_LEVELS.join(", ")}` }).optional(),
  ...pagingQuery,
});
const actionsQuery = z.strictObject({ campaignId: campaignIdQuery, ...pagingQuery });
const exportQuery = z.strictObject({ campaignId: campaignIdQuery });

const shape = settingsSchema.shape;
/**
 * A settings change: any top-level setting, nested groups one field at a time. Each field is
 * checked here; checks across fields (end after start, min before max) run on the merged result.
 */
const settingsPatchSchema = z.strictObject(
  {
    timeZone: shape.timeZone.exactOptional(),
    workingDays: shape.workingDays.exactOptional(),
    workingHours: z.strictObject(shape.workingHours.shape).exactPartial().exactOptional(),
    actionGapSeconds: z.strictObject(shape.actionGapSeconds.shape).exactPartial().exactOptional(),
    breaks: z.strictObject(shape.breaks.shape).exactPartial().exactOptional(),
    limits: z.strictObject(shape.limits.shape).exactPartial().exactOptional(),
    warmUp: z.strictObject(shape.warmUp.shape).exactPartial().exactOptional(),
    inviteLimitCooldownDays: shape.inviteLimitCooldownDays.exactOptional(),
    ai: z.strictObject(shape.ai.shape).exactPartial().exactOptional(),
    keepAwake: shape.keepAwake.exactOptional(),
  } satisfies Record<keyof SettingsPatch, z.ZodType>,
  { error: "Send a JSON object of settings" },
) satisfies z.ZodType<SettingsPatch>;

const SETTINGS_ERROR = "Some settings are not valid";

const TYPE_WORDS: Readonly<Record<string, string>> = {
  number: "Enter a number",
  int: "Enter a whole number",
  string: "Send text",
  boolean: "Send true or false",
  array: "Send a list",
  object: "Send an object",
};

/** Plain words for zod's built-in issues; the settings schema's own messages are kept as they are. */
function settingsIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return TYPE_WORDS[issue.expected] ?? issue.message;
    case "too_small":
      if (issue.origin === "array") return `Choose at least ${String(issue.minimum)}`;
      return issue.inclusive === false ? `Enter more than ${String(issue.minimum)}` : `Enter ${String(issue.minimum)} or more`;
    case "too_big":
      if (issue.origin === "array") return `Choose at most ${String(issue.maximum)}`;
      return issue.inclusive === false ? `Enter less than ${String(issue.maximum)}` : `Enter ${String(issue.maximum)} or less`;
    case "invalid_value":
      return `Choose one of: ${issue.values.map(String).join(", ")}`;
    default:
      return issue.message;
  }
}

function settingsProblems(error: z.ZodError): FieldProblems {
  return fieldProblems(new z.ZodError(error.issues.map((issue) => ({ ...issue, message: settingsIssue(issue) }))));
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  { db, session, now }: { readonly db: Db; readonly session: SessionCheck; readonly now: () => Date },
): void {
  app.get("/api/home", async () => home(db, now(), session.running));

  app.post("/api/safety-stop/resume", async (request, reply) => {
    if (!noBody.safeParse(request.body).success) return reply.code(400).send(NO_BODY_ERROR);
    const resumed = db.transaction((tx) => resumeSafetyStop(tx, now()));
    return resumed ? reply.send({ resumed: true }) : reply.code(409).send({ error: "There is no safety stop to resume" });
  });

  app.get("/api/activity", async (request, reply) => {
    const query = check(activityQuery, request.query);
    if (!query.ok) return reply.code(400).send(query.body);
    const { campaignId, level, ...paging } = query.value;
    return sendOutcome(reply, activity(db, { campaignId: campaignId ?? null, level: level ?? null, ...paging }), (page) => page);
  });

  app.get("/api/actions", async (request, reply) => {
    const query = check(actionsQuery, request.query);
    if (!query.ok) return reply.code(400).send(query.body);
    const { campaignId, ...paging } = query.value;
    return sendOutcome(reply, ledger(db, { campaignId: campaignId ?? null, ...paging }), (page) => page);
  });

  app.get("/api/stats", async () => stats(db));

  app.get("/api/settings", async () => getSettings(db));

  app.patch("/api/settings", async (request, reply) => {
    const patch = check(settingsPatchSchema, orEmpty(request.body), settingsProblems);
    if (!patch.ok) return reply.code(400).send({ ...patch.body, error: SETTINGS_ERROR });
    try {
      return reply.send(setSettings(db, patch.value, now()));
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: SETTINGS_ERROR, fields: settingsProblems(error) });
      throw error;
    }
  });

  app.get("/api/export/prospects.csv", async (request, reply) => {
    const query = check(exportQuery, request.query);
    if (!query.ok) return reply.code(400).send(query.body);
    const campaignId = query.value.campaignId ?? null;
    const filename = campaignId === null ? "prospects.csv" : `prospects-campaign-${campaignId}.csv`;
    return sendOutcome(reply, exportProspects(db, campaignId), (csv) => {
      void reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${filename}"`);
      return csv;
    });
  });
}
