CREATE TABLE `conversationMessages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`orgId` text NOT NULL,
	`hermesSessionId` text NOT NULL,
	`title` text,
	`turnStartedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `orgAgentEndpoints` (
	`orgId` text PRIMARY KEY NOT NULL,
	`baseUrl` text NOT NULL,
	`apiKeyRef` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
