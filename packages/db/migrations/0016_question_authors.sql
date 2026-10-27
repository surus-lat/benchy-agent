CREATE TABLE `questionAuthors` (
	`orgId` text NOT NULL,
	`bench` text NOT NULL,
	`q` integer NOT NULL,
	`qHash` text NOT NULL,
	`userId` text,
	`userName` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`orgId`, `bench`, `q`),
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
