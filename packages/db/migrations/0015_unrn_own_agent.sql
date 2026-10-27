-- Give UNRN its own agent (agent-conicet) instead of sharing agent-surus.
-- The Worker reads env[apiKeyRef] at runtime, so AGENT_KEY_CONICET must be
-- set as a Worker secret before this migration runs.
UPDATE `orgAgentEndpoints`
SET `baseUrl` = 'https://agent-conicet.agents.getbenchy.lat',
    `apiKeyRef` = 'AGENT_KEY_CONICET'
WHERE `orgId` = 'org_e188413528d8377d';
