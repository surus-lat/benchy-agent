-- Add Universidad de Tres de Febrero org and allow @untref.edu.ar sign-in
INSERT INTO `orgs` (`id`, `name`, `slug`, `createdAt`) VALUES ('org_345db718739fd343', 'Universidad de Tres de Febrero', 'untref', 1793152933);--> statement-breakpoint
INSERT INTO `orgDomains` (`domain`, `orgId`, `createdAt`) VALUES ('untref.edu.ar', 'org_345db718739fd343', 1793152933);
