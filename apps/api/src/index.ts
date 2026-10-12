import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "cloudflare:workers";
import { auth } from "./auth";
import { db } from "./db";
import { createAccessRequestsApp } from "./access-requests";
import { createConversationsApp } from "./conversations";
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

// The researcher's conversations with their org's agent (one Hermes per org).
app.route(
  "/",
  createConversationsApp({
    db,
    async currentUser(request) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return null;
      const u = session.user as { id: string; name?: string; email: string; orgId?: string | null };
      return { id: u.id, name: u.name ?? "", email: u.email, orgId: u.orgId ?? null };
    },
    async agentFor(orgId) {
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
    },
  }),
);

app.get("/health", (c) => c.json({ ok: true }));
// Reachable through the Pages proxy; the Worker has no public URL of its own.
app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
