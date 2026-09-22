import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "cloudflare:workers";
import { auth } from "./auth";
import { db } from "./db";
import { createAccessRequestsApp } from "./access-requests";

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

// Public Request Access form. Turnstile-gated; never creates orgs or invites.
app.route(
  "/",
  createAccessRequestsApp({
    db,
    turnstileSecret: env.TURNSTILE_SECRET_KEY,
    notify: { email: env.EMAIL, to: env.OWNER_NOTIFY_EMAIL, from: env.EMAIL_FROM },
  }),
);

app.get("/health", (c) => c.json({ ok: true }));
// Reachable through the Pages proxy; the Worker has no public URL of its own.
app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
