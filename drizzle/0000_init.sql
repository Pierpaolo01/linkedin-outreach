CREATE TABLE `actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`prospect_id` integer,
	`campaign_id` integer,
	`status` text DEFAULT 'planned' NOT NULL,
	`idempotency_key` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	`screenshot_path` text,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_idempotency_key_unique` ON `actions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `actions_type_started_idx` ON `actions` (`type`,`started_at`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`discovery_source` text NOT NULL,
	`source_urls` text DEFAULT '[]' NOT NULL,
	`search_filters` text,
	`keywords` text,
	`location` text,
	`exclusions` text,
	`scoring_brief` text DEFAULT '' NOT NULL,
	`score_threshold` integer DEFAULT 7 NOT NULL,
	`auto_approve` integer DEFAULT false NOT NULL,
	`open_profile_threshold` integer DEFAULT 6 NOT NULL,
	`target_prospect_count` integer,
	`batch_size` integer DEFAULT 25 NOT NULL,
	`invite_note` text,
	`first_message` text DEFAULT '' NOT NULL,
	`follow_up` text DEFAULT '' NOT NULL,
	`ai_personalise` integer DEFAULT false NOT NULL,
	`personalisation_instructions` text,
	`accept_to_message_min_hours` integer DEFAULT 24 NOT NULL,
	`accept_to_message_max_hours` integer DEFAULT 48 NOT NULL,
	`follow_up_delay_min_hours` integer DEFAULT 24 NOT NULL,
	`follow_up_delay_max_hours` integer DEFAULT 48 NOT NULL,
	`delay_policy` text DEFAULT 'calendar' NOT NULL,
	`withdraw_after_days` integer DEFAULT 21 NOT NULL,
	`weight` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `discovery_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`cursor` text,
	`exhausted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `event_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`campaign_id` integer,
	`prospect_id` integer,
	`message` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `event_log_level_at_idx` ON `event_log` (`level`,`at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`run_after` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`locked_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_after_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`urn` text,
	`profile_url` text NOT NULL,
	`full_name` text NOT NULL,
	`first_name` text,
	`headline` text,
	`title` text,
	`company` text,
	`location` text,
	`connection_degree` integer,
	`discovery_source` text,
	`industry_evidence` text,
	`size_evidence` text,
	`raw` text,
	`first_seen_at` integer NOT NULL,
	`do_not_contact` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_public_id_unique` ON `people` (`public_id`);--> statement-breakpoint
CREATE TABLE `prospects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`person_id` integer NOT NULL,
	`score` real,
	`score_reason` text,
	`score_model` text,
	`stage` text DEFAULT 'found' NOT NULL,
	`stop_reason` text,
	`review_reason` text,
	`next_action_at` integer,
	`invite_note_sent` text,
	`first_message_sent` text,
	`follow_up_sent` text,
	`ai_line` text,
	`found_at` integer NOT NULL,
	`approved_at` integer,
	`invited_at` integer,
	`acceptance_observed_at` integer,
	`first_message_sent_at` integer,
	`follow_up_sent_at` integer,
	`reply_detected_at` integer,
	`closed_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prospects_campaign_person_unique` ON `prospects` (`campaign_id`,`person_id`);--> statement-breakpoint
CREATE INDEX `prospects_person_idx` ON `prospects` (`person_id`);--> statement-breakpoint
CREATE INDEX `prospects_stage_next_action_idx` ON `prospects` (`stage`,`next_action_at`);--> statement-breakpoint
CREATE TABLE `session_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_checked_at` integer,
	`last_error` text,
	`screenshot_path` text,
	CONSTRAINT "session_state_single_row" CHECK("session_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
