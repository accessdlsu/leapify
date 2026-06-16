-- Migration: Add registrations table for per-student registration tracking
--> statement-breakpoint
CREATE TABLE `registrations` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `email` text NOT NULL,
  `submitted_at` integer NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_registrations_event_email` ON `registrations` (`event_id`, `email`);
--> statement-breakpoint
CREATE INDEX `idx_registrations_email` ON `registrations` (`email`);
