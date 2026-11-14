import type { z } from "zod";
import {
  activityItemSchema,
  actionItemSchema,
  aiTestSchema,
  approvalItemSchema,
  approveAllSchema,
  backupResultSchema,
  campaignEnvelopeSchema,
  campaignPreviewSchema,
  campaignsSchema,
  campaignUpdateSchema,
  errorBodySchema,
  healthSchema,
  homeSchema,
  opsSchema,
  pageSchema,
  personEnvelopeSchema,
  prospectEnvelopeSchema,
  prospectSchema,
  resumedSchema,
  reviewItemSchema,
  sessionCheckFailedSchema,
  sessionSchema,
  settingsSchema,
  statsSchema,
  type CampaignFields,
  type EVENT_LEVELS,
  type PROSPECT_STAGES,
  type ResolveStage,
  type Session,
  type SettingsPatch,
} from "./apiSchemas";

/**
 * Every route of `docs/api.md` as a typed function. Responses are parsed with zod; any failure
 * (an error status, an unreachable app, an answer of the wrong shape) is thrown as an ApiError.
 */

/** A failed call. `fields` carries the server's message per field (dotted paths), when it sent them. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly fields: Readonly<Record<string, string>>;

  constructor({ status, message, fields = {} }: { status: number; message: string; fields?: Readonly<Record<string, string>> }) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError({ status: 0, message: error instanceof Error ? error.message : String(error) });
}

const UNREACHABLE = "Cannot reach the app. Is it still running?";
const NOT_UNDERSTOOD = "The app sent an answer the dashboard does not understand. Restart the app; if it keeps happening, run doctor.";

/** Adds the query's string and number values to `path`; null and undefined values are left out. */
function withQuery(path: string, query: object = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (typeof value === "string" || typeof value === "number") params.set(key, String(value));
  const text = params.toString();
  return text === "" ? path : `${path}?${text}`;
}

async function send(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}): Promise<{ res: Response; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(path, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError({ status: 0, message: UNREACHABLE });
  }
  const json: unknown = await res.json().catch(() => undefined);
  return { res, json };
}

function failure(res: Response, json: unknown): ApiError {
  const parsed = errorBodySchema.safeParse(json);
  if (parsed.success) return new ApiError({ status: res.status, message: parsed.data.error, fields: parsed.data.fields ?? {} });
  return new ApiError({ status: res.status, message: `The app answered with an error (${res.status}).` });
}

async function request<S extends z.ZodType>(schema: S, path: string, init: { method?: string; body?: unknown } = {}): Promise<z.output<S>> {
  const { res, json } = await send(path, init);
  if (!res.ok) throw failure(res, json);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError({ status: res.status, message: NOT_UNDERSTOOD });
  return parsed.data;
}

const post = <S extends z.ZodType>(schema: S, path: string, body?: unknown) => request(schema, path, { method: "POST", body });

interface Paging {
  readonly page?: number;
  readonly pageSize?: number;
}

// ------------------------------------------------------------ session and Home

export const getHealth = () => request(healthSchema, "/api/health");
export const getSession = () => request(sessionSchema, "/api/session");

export type CheckResult =
  | { readonly kind: "checked"; readonly session: Session }
  | { readonly kind: "failed"; readonly session: Session; readonly error: string }
  | { readonly kind: "busy" };

/** Asks the app to check the LinkedIn session now. A check already running is not an error. */
export async function checkSession(): Promise<CheckResult> {
  const { res, json } = await send("/api/session/check", { method: "POST" });
  if (res.ok) {
    const session = sessionSchema.safeParse(json);
    if (!session.success) throw new ApiError({ status: res.status, message: NOT_UNDERSTOOD });
    return { kind: "checked", session: session.data };
  }
  if (res.status === 409) return { kind: "busy" };
  if (res.status === 502) {
    const failed = sessionCheckFailedSchema.safeParse(json);
    if (failed.success) return { kind: "failed", session: failed.data.session, error: failed.data.error };
  }
  throw failure(res, json);
}

export const getHome = () => request(homeSchema, "/api/home");
export const resumeSafetyStop = () => post(resumedSchema, "/api/safety-stop/resume");

// ------------------------------------------------------------ campaigns

export const listCampaigns = () => request(campaignsSchema, "/api/campaigns");
export const createCampaign = (fields: CampaignFields = {}) => post(campaignEnvelopeSchema, "/api/campaigns", fields);
export const getCampaign = (id: number) => request(campaignEnvelopeSchema, `/api/campaigns/${id}`);
export const updateCampaign = (id: number, fields: CampaignFields) =>
  request(campaignUpdateSchema, `/api/campaigns/${id}`, { method: "PATCH", body: fields });
export const startCampaign = (id: number) => post(campaignEnvelopeSchema, `/api/campaigns/${id}/start`);
export const pauseCampaign = (id: number) => post(campaignEnvelopeSchema, `/api/campaigns/${id}/pause`);
export const resumeCampaign = (id: number) => post(campaignEnvelopeSchema, `/api/campaigns/${id}/resume`);
export const archiveCampaign = (id: number) => post(campaignEnvelopeSchema, `/api/campaigns/${id}/archive`);

/** Renders the campaign's texts for its first prospects. Unsaved form values replace the stored ones. */
export const previewCampaign = (id: number, unsaved: Pick<CampaignFields, "inviteNote" | "firstMessage" | "followUp" | "aiPersonalise"> = {}) =>
  post(campaignPreviewSchema, `/api/campaigns/${id}/preview`, unsaved);

export const listCampaignProspects = (id: number, query: Paging & { readonly stage?: (typeof PROSPECT_STAGES)[number] } = {}) =>
  request(pageSchema(prospectSchema), withQuery(`/api/campaigns/${id}/prospects`, query));

// ------------------------------------------------------------ approval queue

export const listApprovals = (query: Paging & { readonly campaignId?: number | null; readonly minScore?: number | null } = {}) =>
  request(pageSchema(approvalItemSchema), withQuery("/api/approvals", query));
export const approveProspect = (id: number) => post(prospectEnvelopeSchema, `/api/prospects/${id}/approve`);
export const rejectProspect = (id: number) => post(prospectEnvelopeSchema, `/api/prospects/${id}/reject`);
/** Approves exactly these prospects (the rows on screen, 1 to 500). Those no longer waiting are skipped. */
export const approveAll = (prospectIds: readonly number[]) => post(approveAllSchema, "/api/approvals/approve-all", { prospectIds });

// ------------------------------------------------------------ needs review

export const listReview = (query: Paging & { readonly campaignId?: number | null } = {}) =>
  request(pageSchema(reviewItemSchema), withQuery("/api/review", query));
export const resolveReview = (id: number, body: { readonly stage: ResolveStage; readonly note?: string | null }) =>
  post(prospectEnvelopeSchema, `/api/prospects/${id}/resolve`, body);

// ------------------------------------------------------------ people

export const setDoNotContact = (personId: number, doNotContact: boolean) =>
  post(personEnvelopeSchema, `/api/people/${personId}/do-not-contact`, { doNotContact });

// ------------------------------------------------------------ activity, ledger, stats, settings, export

export const listActivity = (
  query: Paging & { readonly campaignId?: number | null; readonly level?: (typeof EVENT_LEVELS)[number] | null } = {},
) => request(pageSchema(activityItemSchema), withQuery("/api/activity", query));
export const listActions = (query: Paging & { readonly campaignId?: number | null } = {}) =>
  request(pageSchema(actionItemSchema), withQuery("/api/actions", query));
export const getStats = () => request(statsSchema, "/api/stats");
export const getSettings = () => request(settingsSchema, "/api/settings");
export const updateSettings = (patch: SettingsPatch) => request(settingsSchema, "/api/settings", { method: "PATCH", body: patch });

/** The address of the prospects CSV (all campaigns, or one), for a plain download link. */
export const prospectsCsvUrl = (campaignId?: number) => withQuery("/api/export/prospects.csv", { campaignId });

// ------------------------------------------------------------ operations and the AI test

export const getOps = () => request(opsSchema, "/api/ops");
export const backUpNow = () => post(backupResultSchema, "/api/ops/backup");
/** Asks the configured AI one small question. It can take 20 seconds. */
export const testAi = () => post(aiTestSchema, "/api/ai/test");
