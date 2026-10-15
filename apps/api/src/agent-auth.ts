// Calls from an org's agent container back to the Worker (today: the paper
// library). The container proves which org it is with the same key the
// Worker uses to reach it (AGENT_KEY_<ORG>, named in orgAgentEndpoints), so
// there is no second credential to provision or rotate.

export type AgentEndpoint = { orgId: string; apiKeyRef: string };

const encoder = new TextEncoder();

function sameSecret(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

/** The org whose agent key this request carries, or null. */
export function agentOrgFor(request: Request, endpoints: AgentEndpoint[], secrets: Record<string, unknown>): string | null {
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer (\S{16,})$/);
  if (!m) return null;
  let found: string | null = null;
  // Every endpoint is compared, so the time taken does not say which org matched.
  for (const e of endpoints) {
    const key = secrets[e.apiKeyRef];
    if (typeof key === "string" && key && sameSecret(m[1], key) && !found) found = e.orgId;
  }
  return found;
}
