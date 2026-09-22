CREATE TABLE `accessRequests` (
	`id` text PRIMARY KEY NOT NULL,
	`orgName` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`message` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accessRequests_email_unique` ON `accessRequests` (`email`);