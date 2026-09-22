import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";

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

app.get("/health", (c) => c.json({ ok: true }));
// Reachable through the Pages proxy; the Worker has no public URL of its own.
app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
