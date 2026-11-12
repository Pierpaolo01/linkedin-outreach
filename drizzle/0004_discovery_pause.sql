ALTER TABLE `discovery_runs` ADD `paused_until` integer;--> statement-breakpoint
ALTER TABLE `discovery_runs` ADD `empty_loads` integer DEFAULT 0 NOT NULL;