-- Migration: Rename is_major column to is_spotlight in events table
--> statement-breakpoint
ALTER TABLE `events` RENAME COLUMN `is_major` TO `is_spotlight`;
