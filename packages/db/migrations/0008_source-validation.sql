CREATE TABLE `sourceChecklistItems` (
	`orgId` text NOT NULL,
	`id` text NOT NULL,
	`label` text NOT NULL,
	`position` integer NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`orgId`, `id`),
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sourceValidations` (
	`orgId` text NOT NULL,
	`bench` text NOT NULL,
	`sourceId` text NOT NULL,
	`checked` text DEFAULT '[]' NOT NULL,
	`validatedAt` integer,
	`validatedBy` text,
	`validatedByName` text,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`orgId`, `bench`, `sourceId`),
	FOREIGN KEY (`orgId`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Every org that already exists starts with the placeholder checklist (the
-- concrete list is still to be defined; these are the issue's three examples).
-- Orgs created later get the same items from the API the first time it reads
-- the org's checklist.
INSERT INTO `sourceChecklistItems` (`orgId`, `id`, `label`, `position`, `createdAt`)
  SELECT `id`, 'respaldo', 'Respaldo editorial o institucional', 0, strftime('%s','now') FROM `orgs`;
--> statement-breakpoint
INSERT INTO `sourceChecklistItems` (`orgId`, `id`, `label`, `position`, `createdAt`)
  SELECT `id`, 'formato', 'Formato legible: PDF con texto seleccionable', 1, strftime('%s','now') FROM `orgs`;
--> statement-breakpoint
INSERT INTO `sourceChecklistItems` (`orgId`, `id`, `label`, `position`, `createdAt`)
  SELECT `id`, 'trazabilidad', 'Trazabilidad de la fuente: autoría, año y procedencia identificables', 2, strftime('%s','now') FROM `orgs`;
