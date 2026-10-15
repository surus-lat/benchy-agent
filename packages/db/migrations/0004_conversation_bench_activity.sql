CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`orgId` text NOT NULL,
	`userId` text,
	`who` text NOT NULL,
	`bench` text,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `bench` text;