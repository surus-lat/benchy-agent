import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { backupAll, BACKUP_DAYS } from "../src/backup";
import { HermesError, type HermesClient } from "../src/hermes";

// The daily backup: every org's workspace archive lands in KV under its date,
// and one org's failing agent does not stop the others.

function agent(archive: () => Promise<ArrayBuffer>): HermesClient {
  return { backup: archive } as unknown as HermesClient;
}

it("keeps one dated archive per org and carries on past a failing agent", async () => {
  const now = new Date("2026-10-15T06:17:00Z");
  const agents: Record<string, HermesClient | null> = {
    org_surus: agent(async () => new TextEncoder().encode("surus-tar").buffer as ArrayBuffer),
    org_down: agent(async () => {
      throw new HermesError("agent unreachable", 502);
    }),
    org_conicet: agent(async () => new TextEncoder().encode("conicet-tar!").buffer as ArrayBuffer),
    org_new: null,
  };
  const outcomes = await backupAll({
    endpoints: Object.keys(agents).map((orgId) => ({ orgId })),
    agentFor: async (orgId) => agents[orgId],
    store: env.BACKUPS,
    now,
  });
  expect(outcomes).toEqual([
    { orgId: "org_surus", ok: true, bytes: 9 },
    { orgId: "org_down", ok: false, error: "agent unreachable" },
    { orgId: "org_conicet", ok: true, bytes: 12 },
    { orgId: "org_new", ok: false, error: "agent not provisioned" },
  ]);
  expect(await env.BACKUPS.get("backup/org_conicet/2026-10-15.tar.gz")).toBe("conicet-tar!");
  const { keys } = await env.BACKUPS.list({ prefix: "backup/" });
  expect(keys.map((k) => k.name).sort()).toEqual(["backup/org_conicet/2026-10-15.tar.gz", "backup/org_surus/2026-10-15.tar.gz"]);
  expect(BACKUP_DAYS).toBeGreaterThanOrEqual(30);
});
