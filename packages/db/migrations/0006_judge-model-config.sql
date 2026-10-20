CREATE TABLE `benchJudgeOverrides` (
	`orgId` text NOT NULL,
	`bench` text NOT NULL,
	`judgeModel` text NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`orgId`, `bench`),
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `orgs` ADD `judgeModel` text;