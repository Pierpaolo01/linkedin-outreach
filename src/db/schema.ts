import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Data model, spec v1.2 section 4. Every timestamp is a UTC instant stored as
 * integer milliseconds (`mode: "timestamp_ms"` reads it back as a Date).
 */

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
const flag = (name: string) => integer(name, { mode: "boolean" });

export const SESSION_STATUSES = ["unknown", "ok", "logged_out", "checkpoint", "restricted", "search_capped"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const CAMPAIGN_STATUSES = [
  "draft",
  "finding",
  "awaiting_approval",
  "running",
  "paused",
  "completed",
  "archived",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const DISCOVERY_SOURCES = ["recommendations", "search"] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

/** How a campaign's delays count time (spec section 9, step 6: calendar versus working-day treatment). */
export const DELAY_POLICIES = ["calendar", "working_days"] as const;
export type DelayPolicy = (typeof DELAY_POLICIES)[number];

/** Prospect lifecycle, spec section 5. */
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
] as const;
export type ProspectStage = (typeof PROSPECT_STAGES)[number];

/** Stages in which a prospect's sequence is over. Every other stage is active: a person has at most one active prospect. */
export const CLOSED_STAGES = ["rejected", "completed", "withdrawn", "stopped"] as const satisfies readonly ProspectStage[];

export const STOP_REASONS = ["replied", "manual_takeover"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const ACTION_TYPES = [
  "search_page",
  "recommendation_page",
  "profile_view",
  "invite",
  "withdraw",
  "message",
  "thread_check",
  "connections_check",
  "health_check",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_STATUSES = ["planned", "in_progress", "done", "failed", "unknown"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Why all LinkedIn activity was halted (spec section 6, "Safety stop"). */
export const SAFETY_STOP_REASONS = ["logged_out", "checkpoint", "restricted", "limit_hit", "unexpected_pages"] as const;
export type SafetyStopReason = (typeof SAFETY_STOP_REASONS)[number];

export const EVENT_LEVELS = ["info", "warning", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

/** Evidence for an industry or size judgement, kept with where it came from. */
export interface Evidence {
  readonly value: string;
  readonly source: string;
  readonly confidence: number;
}

/** Key/value; values are JSON. Typed access lives in `src/config/settings.ts`. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/** The LinkedIn session as last observed. One row, id 1. */
export const sessionState = sqliteTable(
  "session_state",
  {
    id: integer("id").primaryKey(),
    status: text("status", { enum: SESSION_STATUSES }).notNull().default("unknown"),
    lastCheckedAt: timestamp("last_checked_at"),
    lastError: text("last_error"),
    screenshotPath: text("screenshot_path"),
  },
  (t) => [check("session_state_single_row", sql`${t.id} = 1`)],
);

export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  status: text("status", { enum: CAMPAIGN_STATUSES }).notNull().default("draft"),
  /** While paused: the status to return to on resume. */
  pausedFrom: text("paused_from", { enum: CAMPAIGN_STATUSES }),
  // Targeting
  discoverySource: text("discovery_source", { enum: DISCOVERY_SOURCES }).notNull(),
  sourceUrls: text("source_urls", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  searchFilters: text("search_filters", { mode: "json" }).$type<Record<string, unknown>>(),
  keywords: text("keywords"),
  location: text("location"),
  exclusions: text("exclusions"),
  // Scoring and approval
  scoringBrief: text("scoring_brief").notNull().default(""),
  scoreThreshold: integer("score_threshold").notNull().default(7),
  autoApprove: flag("auto_approve").notNull().default(false),
  openProfileThreshold: integer("open_profile_threshold").notNull().default(6),
  targetProspectCount: integer("target_prospect_count"),
  batchSize: integer("batch_size").notNull().default(25),
  // Templates. A null or empty invite note means no note.
  inviteNote: text("invite_note"),
  firstMessage: text("first_message").notNull().default(""),
  followUp: text("follow_up").notNull().default(""),
  aiPersonalise: flag("ai_personalise").notNull().default(false),
  personalisationInstructions: text("personalisation_instructions"),
  // Timings
  acceptToMessageMinHours: integer("accept_to_message_min_hours").notNull().default(24),
  acceptToMessageMaxHours: integer("accept_to_message_max_hours").notNull().default(48),
  followUpDelayMinHours: integer("follow_up_delay_min_hours").notNull().default(24),
  followUpDelayMaxHours: integer("follow_up_delay_max_hours").notNull().default(48),
  delayPolicy: text("delay_policy", { enum: DELAY_POLICIES }).notNull().default("calendar"),
  withdrawAfterDays: integer("withdraw_after_days").notNull().default(21),
  weight: integer("weight").notNull().default(1),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/** A LinkedIn member, stored once across all campaigns. */
export const people = sqliteTable("people", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** The public profile identifier, the `<id>` in linkedin.com/in/<id>. */
  publicId: text("public_id").notNull().unique(),
  /**
   * LinkedIn's member id (`ACoA…`). Unlike the public id, the member cannot change it, so it is
   * what makes two rows the same person. Known once a profile or connection row has shown it;
   * required before an invite.
   */
  memberId: text("member_id").unique(),
  profileUrl: text("profile_url").notNull(),
  fullName: text("full_name").notNull(),
  firstName: text("first_name"),
  headline: text("headline"),
  title: text("title"),
  company: text("company"),
  location: text("location"),
  connectionDegree: integer("connection_degree"),
  discoverySource: text("discovery_source", { enum: DISCOVERY_SOURCES }),
  industryEvidence: text("industry_evidence", { mode: "json" }).$type<Evidence>(),
  sizeEvidence: text("size_evidence", { mode: "json" }).$type<Evidence>(),
  raw: text("raw", { mode: "json" }).$type<unknown>(),
  firstSeenAt: timestamp("first_seen_at").notNull(),
  /** When the profile was last opened and its fields stored on this row. */
  profileViewedAt: timestamp("profile_viewed_at"),
  doNotContact: flag("do_not_contact").notNull().default(false),
  /**
   * Suppression: set when the first invite to this person is claimed in the ledger, and never
   * cleared. Only `contactedProspectId` may contact the person from then on.
   */
  contactedAt: timestamp("contacted_at"),
  contactedProspectId: integer("contacted_prospect_id"),
});

/** A person inside one campaign. */
export const prospects = sqliteTable(
  "prospects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id),
    /** The score from the card alone (name and headline), before any profile was opened. */
    cardScore: real("card_score"),
    /** The final score: from the profile when one was opened, else the card score. */
    score: real("score"),
    scoreReason: text("score_reason"),
    scoreModel: text("score_model"),
    stage: text("stage", { enum: PROSPECT_STAGES }).notNull().default("found"),
    stopReason: text("stop_reason", { enum: STOP_REASONS }),
    /** Why the prospect is held in needs_review. */
    reviewReason: text("review_reason"),
    nextActionAt: timestamp("next_action_at"),
    // Texts as sent, frozen once sent
    inviteNoteSent: text("invite_note_sent"),
    firstMessageSent: text("first_message_sent"),
    followUpSent: text("follow_up_sent"),
    aiLine: text("ai_line"),
    /** The profile text the AI line rests on, shown at approval. */
    aiLineEvidence: text("ai_line_evidence"),
    // Lifecycle timestamps
    foundAt: timestamp("found_at").notNull(),
    approvedAt: timestamp("approved_at"),
    invitedAt: timestamp("invited_at"),
    acceptanceObservedAt: timestamp("acceptance_observed_at"),
    firstMessageSentAt: timestamp("first_message_sent_at"),
    followUpSentAt: timestamp("follow_up_sent_at"),
    replyDetectedAt: timestamp("reply_detected_at"),
    closedAt: timestamp("closed_at"),
  },
  (t) => [
    uniqueIndex("prospects_campaign_person_unique").on(t.campaignId, t.personId),
    uniqueIndex("prospects_one_active_per_person")
      .on(t.personId)
      .where(sql`${t.stage} NOT IN ('rejected', 'completed', 'withdrawn', 'stopped')`),
    index("prospects_person_idx").on(t.personId),
    index("prospects_stage_next_action_idx").on(t.stage, t.nextActionAt),
  ],
);

/** The ledger: every LinkedIn action, whatever its outcome. Budgets are counted from it. */
export const actions = sqliteTable(
  "actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: ACTION_TYPES }).notNull(),
    prospectId: integer("prospect_id").references(() => prospects.id),
    campaignId: integer("campaign_id").references(() => campaigns.id),
    status: text("status", { enum: ACTION_STATUSES }).notNull().default("planned"),
    /** For example `invite:<prospect>` or `message1:<prospect>`. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** How many times the action was claimed (moved to in_progress). */
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    error: text("error"),
    /** The driver error kind (`unexpected`, `checkpoint`, ...) when the action ended on one. */
    errorKind: text("error_kind"),
    /** What reconciliation needs to know about the claim, e.g. how many of the user's messages the thread held before a send. */
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    screenshotPath: text("screenshot_path"),
  },
  (t) => [index("actions_type_started_idx").on(t.type, t.startedAt)],
);

/** Human-readable audit trail shown in the UI. */
export const eventLog = sqliteTable(
  "event_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: timestamp("at").notNull(),
    level: text("level", { enum: EVENT_LEVELS }).notNull().default("info"),
    campaignId: integer("campaign_id").references(() => campaigns.id),
    prospectId: integer("prospect_id").references(() => prospects.id),
    message: text("message").notNull(),
  },
  (t) => [index("event_log_level_at_idx").on(t.level, t.at)],
);

/** Discovery progress per campaign and source, so a restart does not repeat discovery (spec section 7). */
export const discoveryRuns = sqliteTable("discovery_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  source: text("source", { enum: DISCOVERY_SOURCES }).notNull(),
  sourceUrl: text("source_url"),
  cursor: text("cursor"),
  exhausted: flag("exhausted").notNull().default(false),
  /** Discovery from this source waits until then, e.g. the first day of next month after the search cap. */
  pausedUntil: timestamp("paused_until"),
  /** Loads in a row that brought no new person; a recommendations source is exhausted after a few. */
  emptyLoads: integer("empty_loads").notNull().default(0),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * Safety stops, newest last. The stop is active while `resumedAt` is null; only the user lifts
 * it. Kept apart from `session_state`, which every session check overwrites.
 */
export const safetyStops = sqliteTable("safety_stops", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reason: text("reason", { enum: SAFETY_STOP_REASONS }).notNull(),
  detail: text("detail"),
  screenshotPath: text("screenshot_path"),
  raisedAt: timestamp("raised_at").notNull(),
  resumedAt: timestamp("resumed_at"),
  /** After LinkedIn's own invitation-limit message, invites stay off until this instant even once resumed. */
  invitesBlockedUntil: timestamp("invites_blocked_until"),
});
