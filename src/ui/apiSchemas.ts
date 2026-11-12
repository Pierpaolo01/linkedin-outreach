import { z } from "zod";
import type { CampaignStatus, EventLevel, ProspectStage, SafetyStopReason, SessionStatus } from "../db/schema";

/**
 * The shapes of `docs/api.md`, checked on every response: the dashboard trusts nothing it did not
 * parse. Lists of values are typed against the database's own lists, so a new value fails the build.
 */

const instant = z.iso.datetime();

export const SESSION_STATUSES = ["unknown", "ok", "logged_out", "checkpoint", "restricted", "search_capped"] as const satisfies readonly SessionStatus[];
export const CAMPAIGN_STATUSES = [
  "draft",
  "finding",
  "awaiting_approval",
  "running",
  "paused",
  "completed",
  "archived",
] as const satisfies readonly CampaignStatus[];
export const PROSPECT_STAGES = [
  "found",
  "scored",
  "rejected",
  "pending_approval",
  "approved",
  "invited",
  "accepted",
  "message_sent",
  "follow_up_sent",
  "completed",
  "withdrawn",
  "stopped",
  "needs_review",
] as const satisfies readonly ProspectStage[];
export const SAFETY_STOP_REASONS = ["logged_out", "checkpoint", "restricted", "limit_hit", "unexpected_pages"] as const satisfies readonly SafetyStopReason[];
export const EVENT_LEVELS = ["info", "warning", "error"] as const satisfies readonly EventLevel[];
export const BUDGET_KINDS = ["invite", "message", "profile_view", "discovery_page", "withdraw"] as const;
/** The stages a prospect in needs review may move to. */
export const RESOLVE_STAGES = ["rejected", "stopped", "approved", "invited", "accepted", "message_sent"] as const satisfies readonly ProspectStage[];

export type BudgetKind = (typeof BUDGET_KINDS)[number];
export type ResolveStage = (typeof RESOLVE_STAGES)[number];

// ------------------------------------------------------------ errors

export const errorBodySchema = z.object({
  error: z.string(),
  fields: z.record(z.string(), z.string()).optional(),
});

// ------------------------------------------------------------ session and Home

export const healthSchema = z.object({ ok: z.boolean(), version: z.string(), dbOk: z.boolean() });

export const sessionSchema = z.object({
  status: z.enum(SESSION_STATUSES),
  lastCheckedAt: instant.nullable(),
  lastError: z.string().nullable(),
  /** A check is running right now (the startup check or a Re-check). */
  checking: z.boolean(),
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionCheckFailedSchema = z.object({ error: z.string(), session: sessionSchema });

export const safetyStopSchema = z.object({
  reason: z.enum(SAFETY_STOP_REASONS),
  detail: z.string().nullable(),
  raisedAt: instant,
  whatToDo: z.string(),
  invitesBlockedUntil: instant.nullable(),
});
export type SafetyStop = z.infer<typeof safetyStopSchema>;

/**
 * Why discovery for a campaign waits: LinkedIn's monthly search limit (until when), nobody new in the
 * recommendations today (it looks again tomorrow), or nothing left to find.
 */
const discoveryWaitSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("search_limit"), until: instant, message: z.string() }),
  z.object({ reason: z.literal("no_new_people"), until: instant.nullable(), message: z.string() }),
  z.object({ reason: z.literal("exhausted"), until: z.null(), message: z.string() }),
]);
export type DiscoveryWait = z.infer<typeof discoveryWaitSchema>;

const budgetSchema = z.object({ used: z.number(), limit: z.number(), open: z.boolean(), resumesAt: instant.nullable() });
export type Budget = z.infer<typeof budgetSchema>;

export const homeSchema = z.object({
  session: sessionSchema,
  safetyStop: safetyStopSchema.nullable(),
  usage: z.object({
    invite: budgetSchema,
    message: budgetSchema,
    profile_view: budgetSchema,
    discovery_page: budgetSchema,
    withdraw: budgetSchema,
  } satisfies Record<BudgetKind, typeof budgetSchema>),
  campaigns: z.array(
    z.object({ id: z.number().int(), name: z.string(), status: z.enum(CAMPAIGN_STATUSES), discoveryWait: discoveryWaitSchema.nullable() }),
  ),
  needsYou: z.object({ pendingApproval: z.number().int(), needsReview: z.number().int() }),
});
export type Home = z.infer<typeof homeSchema>;

export const resumedSchema = z.object({ resumed: z.literal(true) });

// ------------------------------------------------------------ campaigns

export const funnelSchema = z.object({
  found: z.number().int(),
  approved: z.number().int(),
  invited: z.number().int(),
  accepted: z.number().int(),
  messaged: z.number().int(),
  replied: z.number().int(),
});

export const campaignSchema = z.object({
  id: z.number().int(),
  status: z.enum(CAMPAIGN_STATUSES),
  name: z.string(),
  discoverySource: z.enum(["recommendations", "search"]),
  sourceUrls: z.array(z.string()),
  targetProspectCount: z.number().int().nullable(),
  scoringBrief: z.string(),
  batchSize: z.number().int(),
  autoApprove: z.boolean(),
  scoreThreshold: z.number(),
  openProfileThreshold: z.number(),
  inviteNote: z.string().nullable(),
  firstMessage: z.string(),
  followUp: z.string(),
  aiPersonalise: z.boolean(),
  personalisationInstructions: z.string().nullable(),
  acceptToMessageMinHours: z.number().int(),
  acceptToMessageMaxHours: z.number().int(),
  followUpDelayMinHours: z.number().int(),
  followUpDelayMaxHours: z.number().int(),
  delayPolicy: z.enum(["calendar", "working_days"]),
  withdrawAfterDays: z.number().int(),
  createdAt: instant,
  updatedAt: instant,
  funnel: funnelSchema,
});
export type Campaign = z.infer<typeof campaignSchema>;

/** The wizard's fields (create and update body). All optional. */
export type CampaignFields = Partial<
  Pick<
    Campaign,
    | "name"
    | "discoverySource"
    | "sourceUrls"
    | "targetProspectCount"
    | "scoringBrief"
    | "batchSize"
    | "autoApprove"
    | "scoreThreshold"
    | "openProfileThreshold"
    | "inviteNote"
    | "firstMessage"
    | "followUp"
    | "aiPersonalise"
    | "personalisationInstructions"
    | "acceptToMessageMinHours"
    | "acceptToMessageMaxHours"
    | "followUpDelayMinHours"
    | "followUpDelayMaxHours"
    | "delayPolicy"
    | "withdrawAfterDays"
  >
>;

export const campaignsSchema = z.object({ campaigns: z.array(campaignSchema) });
export const campaignEnvelopeSchema = z.object({ campaign: campaignSchema });
export const campaignUpdateSchema = z.object({ campaign: campaignSchema, notice: z.string().nullable() });

// ------------------------------------------------------------ texts

export const previewTextSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), text: z.string(), length: z.number().int() }),
  z.object({
    ok: z.literal(false),
    problem: z.enum(["unresolved_variable", "unknown_variable", "malformed", "empty", "too_long"]),
    variables: z.array(z.string()).optional(),
    message: z.string(),
  }),
]);
export type PreviewText = z.infer<typeof previewTextSchema>;

export const previewItemSchema = z.object({
  prospectId: z.number().int().nullable(),
  fullName: z.string(),
  inviteNote: previewTextSchema.nullable(),
  firstMessage: previewTextSchema,
  followUp: previewTextSchema.nullable(),
});
export const campaignPreviewSchema = z.object({ samples: z.enum(["prospects", "invented"]), items: z.array(previewItemSchema) });
export type CampaignPreview = z.infer<typeof campaignPreviewSchema>;

// ------------------------------------------------------------ people and prospects

const evidenceSchema = z.object({ value: z.string(), source: z.string(), confidence: z.number() }).nullable();
export type Evidence = z.infer<typeof evidenceSchema>;

export const personSchema = z.object({
  id: z.number().int(),
  fullName: z.string(),
  firstName: z.string().nullable(),
  headline: z.string().nullable(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  profileUrl: z.string(),
  connectionDegree: z.number().int().nullable(),
  industryEvidence: evidenceSchema,
  sizeEvidence: evidenceSchema,
  doNotContact: z.boolean(),
  contactedAt: instant.nullable(),
});
export type Person = z.infer<typeof personSchema>;

export const prospectSchema = z.object({
  id: z.number().int(),
  campaignId: z.number().int(),
  campaignName: z.string(),
  stage: z.enum(PROSPECT_STAGES),
  score: z.number().nullable(),
  cardScore: z.number().nullable(),
  scoreReason: z.string().nullable(),
  stopReason: z.enum(["replied", "manual_takeover"]).nullable(),
  reviewReason: z.string().nullable(),
  nextActionAt: instant.nullable(),
  texts: z.object({ inviteNote: z.string().nullable(), firstMessage: z.string().nullable(), followUp: z.string().nullable() }),
  foundAt: instant,
  approvedAt: instant.nullable(),
  invitedAt: instant.nullable(),
  acceptanceObservedAt: instant.nullable(),
  firstMessageSentAt: instant.nullable(),
  followUpSentAt: instant.nullable(),
  replyDetectedAt: instant.nullable(),
  closedAt: instant.nullable(),
  /** The profile text the AI line rests on. Sent by the server but not yet in docs/api.md, so optional. */
  aiLineEvidence: z.string().nullable().optional(),
  person: personSchema,
});
export type Prospect = z.infer<typeof prospectSchema>;

export const approvalItemSchema = prospectSchema.extend({
  preview: z.object({ inviteNote: previewTextSchema.nullable(), firstMessage: previewTextSchema }),
  /** The follow-up for this person; null when the campaign has no follow-up. */
  followUpPreview: previewTextSchema.nullable(),
});
export type ApprovalItem = z.infer<typeof approvalItemSchema>;

/** `screenshotUrl`: a same-origin path to the PNG of the page the app saw, or null when there is none. */
export const reviewItemSchema = prospectSchema.extend({ screenshotUrl: z.string().nullable() });
export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const prospectEnvelopeSchema = z.object({ prospect: prospectSchema });
export const personEnvelopeSchema = z.object({ person: personSchema });
/** `skipped`: prospects among those sent that were no longer waiting for approval. */
export const approveAllSchema = z.object({ approved: z.number().int(), skipped: z.number().int() });

// ------------------------------------------------------------ paging

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), items: z.array(item) });
}
export interface Page<T> {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly items: readonly T[];
}

// ------------------------------------------------------------ activity, ledger, stats

export const activityItemSchema = z.object({
  id: z.number().int(),
  at: instant,
  level: z.enum(EVENT_LEVELS),
  campaignId: z.number().int().nullable(),
  prospectId: z.number().int().nullable(),
  message: z.string(),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const actionItemSchema = z.object({
  id: z.number().int(),
  type: z.enum([
    "search_page",
    "recommendation_page",
    "profile_view",
    "invite",
    "withdraw",
    "message",
    "thread_check",
    "connections_check",
    "health_check",
  ]),
  status: z.enum(["planned", "in_progress", "done", "failed", "unknown"]),
  campaignId: z.number().int().nullable(),
  prospectId: z.number().int().nullable(),
  personName: z.string().nullable(),
  idempotencyKey: z.string(),
  attempts: z.number().int(),
  startedAt: instant.nullable(),
  finishedAt: instant.nullable(),
  error: z.string().nullable(),
  errorKind: z.string().nullable(),
  screenshotPath: z.string().nullable(),
});
export type ActionItem = z.infer<typeof actionItemSchema>;

export const statsSchema = z.object({
  campaigns: z.array(
    z.object({
      campaignId: z.number().int(),
      name: z.string(),
      status: z.enum(CAMPAIGN_STATUSES),
      invitesSent: z.number().int(),
      accepted: z.number().int(),
      acceptanceRate: z.number().nullable(),
      firstMessagesSent: z.number().int(),
      replies: z.number().int(),
      replyRate: z.object({ label: z.string(), value: z.number().nullable() }),
      medianHoursToAccept: z.number().nullable(),
      invitesWithdrawn: z.number().int(),
    }),
  ),
});
export type Stats = z.infer<typeof statsSchema>;

// ------------------------------------------------------------ settings

export const AI_PROVIDERS = ["claude_cli", "anthropic_api"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

const clock = z.string();
export const settingsSchema = z.object({
  timeZone: z.string(),
  workingDays: z.array(z.number().int().min(1).max(7)),
  workingHours: z.object({ start: clock, end: clock }),
  actionGapSeconds: z.object({ min: z.number(), max: z.number() }),
  breaks: z.object({ everyActionsMin: z.number(), everyActionsMax: z.number(), minutesMin: z.number(), minutesMax: z.number() }),
  limits: z.object({
    invitesPerDay: z.number(),
    invitesPerWeek: z.number(),
    profileViewsPerDay: z.number(),
    messagesPerDay: z.number(),
    discoveryPagesPerDay: z.number(),
    withdrawalsPerDay: z.number(),
  }),
  warmUp: z.object({ enabled: z.boolean(), invitesStartPerDay: z.number(), invitesIncreasePerDay: z.number() }),
  inviteLimitCooldownDays: z.number(),
  ai: z.object({ provider: z.enum(AI_PROVIDERS), model: z.string() }),
  keepAwake: z.boolean(),
});
export type Settings = z.infer<typeof settingsSchema>;

/** A settings change: any top-level setting, nested groups one field at a time. */
export type SettingsPatch = {
  readonly [K in keyof Settings]?: Settings[K] extends readonly unknown[]
    ? Settings[K]
    : Settings[K] extends object
      ? Partial<Settings[K]>
      : Settings[K];
};

// ------------------------------------------------------------ operations (backups, auto-start, keep-awake) and the AI test

export const opsSchema = z.object({
  /** `date` is the backup's calendar day ("2026-11-12") or a timestamp. */
  backups: z.array(z.object({ file: z.string(), date: z.string(), sizeBytes: z.number() })),
  service: z.object({ installed: z.boolean(), loaded: z.boolean(), running: z.boolean(), note: z.string().nullable() }),
  keepAwake: z.object({ enabled: z.boolean(), active: z.boolean() }),
  dataDir: z.string(),
});
export type Ops = z.infer<typeof opsSchema>;

export const backupResultSchema = z.object({
  kind: z.enum(["created", "skipped", "failed"]),
  file: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
});
export type BackupResult = z.infer<typeof backupResultSchema>;

export const aiTestSchema = z.object({
  ok: z.boolean(),
  provider: z.string(),
  model: z.string().nullable(),
  elapsedMs: z.number(),
  message: z.string(),
});
export type AiTest = z.infer<typeof aiTestSchema>;
