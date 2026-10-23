import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "cloudflare:workers";
import { auth } from "./auth";
import { db } from "./db";
import { createAccessRequestsApp } from "./access-requests";
import { createConversationsApp } from "./conversations";
import { createCriteriaLibraryApp } from "./library-criteria";
import { createLibraryApp, getPaper } from "./library";
import { createPeerReviewApp } from "./peer-review";
import { createProcessesApp } from "./processes";
import { agentOrgFor } from "./agent-auth";
import { backupAll } from "./backup";
import { hermesClient } from "./hermes";
import { enabledProviders } from "./social-providers";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";

const app = new Hono<{ Bindings: Env }>();

app.use(
  "/api/auth/*",
  cors({
    // Production is same-origin (Pages proxy); CORS only matters for a dev
    // browser talking to wrangler dev directly.
    origin: ["http://localhost:21707"],
    credentials: true,
  }),
);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Which sign-in buttons to show (providers with real credentials).
app.get("/api/auth-providers", (c) => c.json(enabledProviders(env as unknown as Record<string, unknown>)));

// Public Request Access form. Turnstile-gated; never creates orgs or invites.
app.route(
  "/",
  createAccessRequestsApp({
    db,
    turnstileSecret: env.TURNSTILE_SECRET_KEY,
    notify: { email: env.EMAIL, to: env.OWNER_NOTIFY_EMAIL, from: env.EMAIL_FROM },
  }),
);

async function currentUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  const u = session.user as { id: string; name?: string; email: string; orgId?: string | null };
  return { id: u.id, name: u.name ?? "", email: u.email, orgId: u.orgId ?? null };
}

const publicUrl = env.BETTER_AUTH_URL.replace(/\/+$/, "");

/** The org's Hermes, or null when the org has not been provisioned. */
async function agentFor(orgId: string) {
  const [endpoint] = await db
    .select()
    .from(schema.orgAgentEndpoints)
    .where(eq(schema.orgAgentEndpoints.orgId, orgId))
    .limit(1);
  if (!endpoint) return null;
  // D1 holds only the secret's name; the key lives in Worker secrets.
  const key = (env as unknown as Record<string, unknown>)[endpoint.apiKeyRef];
  if (typeof key !== "string" || !key) {
    console.error(`org ${orgId}: Worker secret ${endpoint.apiKeyRef} is not set`);
    return null;
  }
  return hermesClient(endpoint.baseUrl, key);
}

/** The org whose agent container is calling, by its key; null for anything else. */
async function callingAgentOrg(request: Request): Promise<string | null> {
  if (!request.headers.get("authorization")?.startsWith("Bearer ")) return null;
  const endpoints = await db
    .select({ orgId: schema.orgAgentEndpoints.orgId, apiKeyRef: schema.orgAgentEndpoints.apiKeyRef })
    .from(schema.orgAgentEndpoints);
  return agentOrgFor(request, endpoints, env as unknown as Record<string, unknown>);
}

// The paper library, for anyone signed in and for each org's agent.
app.route(
  "/",
  createLibraryApp({
    library: env.LIBRARY,
    files: env.LIBRARY_FILES,
    publicUrl,
    authorize: async (request) => !!(await currentUser(request)) || !!(await callingAgentOrg(request)),
  }),
);

// The researcher's conversations with their org's agent (one Hermes per org).
app.route(
  "/",
  createConversationsApp({
    db,
    currentUser,
    paper: (id) => getPaper(env.LIBRARY, id, publicUrl),
    agentFor,
  }),
);

// Global process indicators: the caller's own processes plus their org's evaluations.
app.route(
  "/",
  createProcessesApp({ db, currentUser, agentFor }),
);

// The org's library of reusable evaluation criteria (D1 only; the benchmark's
// own copy still lives in benchmark.yaml).
app.route(
  "/",
  createCriteriaLibraryApp({ db, currentUser }),
);

// Peer review of questions inside the org (issue #1): votes in D1, questions
// read through the org's agent; the engine is never touched.
app.route(
  "/",
  createPeerReviewApp({ db, currentUser, agentFor }),
);

app.get("/health", (c) => c.json({ ok: true }));
// Reachable through the Pages proxy; the Worker has no public URL of its own.
app.get("/api/health", (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  // The daily backup of every org's workspace (src/backup.ts).
  async scheduled(_controller: ScheduledController, _env: Env, ctx: ExecutionContext) {
    const endpoints = await db.select({ orgId: schema.orgAgentEndpoints.orgId }).from(schema.orgAgentEndpoints);
    ctx.waitUntil(
      backupAll({ endpoints, agentFor, store: env.BACKUPS }).then((outcomes) =>
        console.log(`backup: ${outcomes.map((o) => `${o.orgId} ${o.ok ? `${o.bytes} B` : o.error}`).join("; ")}`),
      ),
    );
  },
};
