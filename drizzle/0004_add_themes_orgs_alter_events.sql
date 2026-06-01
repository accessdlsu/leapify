-- Migration: Add themes & organizations tables, restructure events table
--> statement-breakpoint
CREATE TABLE `themes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	`updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `themes_name_unique` ON `themes` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `themes_path_unique` ON `themes` (`path`);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`acronym` text NOT NULL,
	`logo_url` text,
	`link` text,
	`created_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_name_unique` ON `organizations` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_acronym_unique` ON `organizations` (`acronym`);
--> statement-breakpoint
ALTER TABLE `events` ADD `theme_id` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `organization_id` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `description` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `class_code` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `start_time` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `end_time` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `gforms_editor_url` text;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_events_category`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `category_name`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `category_path`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `org`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `starts_at`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `ends_at`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `background_color`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `subtheme`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `contentful_entry_id`;
--> statement-breakpoint
ALTER TABLE `events` DROP COLUMN `registration_opens_at`;
--> statement-breakpoint
CREATE INDEX `idx_events_theme_id` ON `events` (`theme_id`);
--> statement-breakpoint
CREATE INDEX `idx_events_organization_id` ON `events` (`organization_id`);
