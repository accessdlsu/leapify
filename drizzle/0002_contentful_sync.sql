-- Migration: Contentful sync tables and configuration
-- This adds support for Cloudflare-only, Contentful-only, and Hybrid integration modes.
--> statement-breakpoint
CREATE TABLE `contentful_config` (
    `space_id` text,
    `management_token` text,
    `contentful_enabled` integer DEFAULT 0 NOT NULL,
    `last_sync_at` integer,
    `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contentful_config_key_unique` ON `contentful_config` (`space_id`);
--> statement-breakpoint
CREATE TABLE `contentful_sync_status` (
    `record_type` text NOT NULL, -- 'themes', 'events', 'organizations', 'faqs'
    `contentful_id` text,
    `d1_id` text,
    `last_sync_at` integer,
    `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
    PRIMARY KEY (`record_type`, `contentful_id`)
);
--> statement-breakpoint
CREATE INDEX `contentful_sync_status_d1_idx` ON `contentful_sync_status` (`d1_id`);
CREATE INDEX `contentful_sync_status_type_idx` ON `contentful_sync_status` (`record_type`);