-- Migration: Add registration_enabled toggle to events
--> statement-breakpoint
ALTER TABLE `events` ADD `registration_enabled` integer NOT NULL DEFAULT 1;
