CREATE TABLE `orgDomains` (
	`domain` text PRIMARY KEY NOT NULL,
	`orgId` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
