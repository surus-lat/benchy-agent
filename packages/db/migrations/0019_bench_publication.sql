-- Publishing a benchmark: the frozen copy lives in the workspace
-- (<bench>/published/vN/); these rows are the app's record of where the
-- working copy stands and of what each version was.
CREATE TABLE `benchPublications` (
	`orgId` text NOT NULL,
	`bench` text NOT NULL,
	`state` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`basedOn` integer,
	`updatedAt` integer NOT NULL,
	`userId` text,
	`userName` text NOT NULL,
	PRIMARY KEY(`orgId`, `bench`),
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `benchPublicationVersions` (
	`orgId` text NOT NULL,
	`bench` text NOT NULL,
	`version` integer NOT NULL,
	`note` text,
	`manifest` text NOT NULL,
	`publishedAt` integer NOT NULL,
	`userId` text,
	`userName` text NOT NULL,
	PRIMARY KEY(`orgId`, `bench`, `version`),
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
