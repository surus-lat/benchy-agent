// Daily backup of every org's workspace (benchmarks, papers, runs, reports),
// which lives on a single Railway volume: the Worker's cron asks each org's
// agent for a .tar.gz and keeps it in KV for BACKUP_DAYS. Off Railway on
// purpose — a copy on the same platform does not survive losing the account.
//
// Restore: npx wrangler kv key get "backup/<orgId>/<date>.tar.gz" --binding BACKUPS --remote > ws.tar.gz
// then unpack it into the agent's /opt/data/workspace.

import type { HermesClient } from "./hermes";

export const BACKUP_DAYS = 35;

export type BackupDeps = {
  endpoints: { orgId: string }[];
  agentFor: (orgId: string) => Promise<HermesClient | null>;
  store: KVNamespace;
  now?: Date;
};

export type BackupOutcome = { orgId: string; ok: boolean; bytes?: number; error?: string };

export async function backupAll(deps: BackupDeps): Promise<BackupOutcome[]> {
  const day = (deps.now ?? new Date()).toISOString().slice(0, 10);
  const outcomes: BackupOutcome[] = [];
  // One org at a time: a failing agent must not stop the others' backups.
  for (const { orgId } of deps.endpoints) {
    try {
      const agent = await deps.agentFor(orgId);
      if (!agent) throw new Error("agent not provisioned");
      const archive = await agent.backup();
      await deps.store.put(`backup/${orgId}/${day}.tar.gz`, archive, {
        expirationTtl: BACKUP_DAYS * 24 * 60 * 60,
        metadata: { bytes: archive.byteLength, at: Date.now() },
      });
      outcomes.push({ orgId, ok: true, bytes: archive.byteLength });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`backup of ${orgId} failed: ${error}`);
      outcomes.push({ orgId, ok: false, error });
    }
  }
  return outcomes;
}
