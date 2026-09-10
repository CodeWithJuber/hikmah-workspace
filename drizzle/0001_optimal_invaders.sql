CREATE TABLE `context_active` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`language` text NOT NULL,
	`version_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `context_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`language` text NOT NULL,
	`blob_key` text NOT NULL,
	`receipt` text NOT NULL,
	`created_at` text NOT NULL
);
