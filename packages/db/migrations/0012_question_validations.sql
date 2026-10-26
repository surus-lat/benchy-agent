CREATE TABLE `questionValidations` (
	`id` text PRIMARY KEY NOT NULL,
	`orgId` text NOT NULL,
	`bench` text NOT NULL,
	`q` integer NOT NULL,
	`qHash` text NOT NULL,
	`userId` text,
	`vote` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- One vote row per member per question; the upsert in the API replaces it.
CREATE UNIQUE INDEX `questionValidations_org_bench_q_user` ON `questionValidations` (`orgId`,`bench`,`q`,`userId`);
