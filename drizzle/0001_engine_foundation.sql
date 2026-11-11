CREATE TABLE `safety_stops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`screenshot_path` text,
	`raised_at` integer NOT NULL,
	`resumed_at` integer,
	`invites_blocked_until` integer
);
--> statement-breakpoint
ALTER TABLE `actions` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `actions` ADD `error_kind` text;--> statement-breakpoint
ALTER TABLE `actions` ADD `detail` text;--> statement-breakpoint
ALTER TABLE `people` ADD `member_id` text;--> statement-breakpoint
ALTER TABLE `people` ADD `contacted_at` integer;--> statement-breakpoint
ALTER TABLE `people` ADD `contacted_prospect_id` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `people_member_id_unique` ON `people` (`member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `prospects_one_active_per_person` ON `prospects` (`person_id`) WHERE "prospects"."stage" NOT IN ('rejected', 'completed', 'withdrawn', 'stopped');