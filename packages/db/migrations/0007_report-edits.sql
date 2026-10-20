CREATE TABLE `benchReportEdits` (
	`orgId` text NOT NULL,
	`bench` text NOT NULL,
	`markdown` text NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`orgId`, `bench`),
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
