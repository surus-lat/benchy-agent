-- Point UNTREF org to its own dedicated agent (agent-untref)
-- The Worker reads env[apiKeyRef] at runtime, so AGENT_KEY_UNTREF must be
-- set as a Worker secret before this migration runs.
INSERT INTO `orgAgentEndpoints` (`orgId`, `baseUrl`, `apiKeyRef`, `createdAt`)
VALUES ('org_345db718739fd343', 'https://agent-untref.agents.getbenchy.lat', 'AGENT_KEY_UNTREF', 1793152933);
