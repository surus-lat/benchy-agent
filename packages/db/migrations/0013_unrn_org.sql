-- Add Universidad Nacional de Río Negro org and allow @unrn.edu.ar sign-in
INSERT INTO `orgs` (`id`, `name`, `slug`) VALUES ('org_e188413528d8377d', 'Universidad Nacional de Río Negro', 'unrn');--> statement-breakpoint
INSERT INTO `orgDomains` (`domain`, `orgId`, `createdAt`) VALUES ('unrn.edu.ar', 'org_e188413528d8377d', 1793107055);
