-- Migration: Add image, description, and sort_order columns to themes table
--> statement-breakpoint
ALTER TABLE `themes` ADD `image_url` text;
--> statement-breakpoint
ALTER TABLE `themes` ADD `description_en` text;
--> statement-breakpoint
ALTER TABLE `themes` ADD `description_fil` text;
--> statement-breakpoint
ALTER TABLE `themes` ADD `sort_order` integer NOT NULL DEFAULT 0;
