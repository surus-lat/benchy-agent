import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";

const app = new Hono<{ Bindings: Env }>();

app.use(
  "/api/auth/*",
  cors({
    origin: ["https://app.benchy.example", "http://localhost:21707"],
    credentials: true,
  }),
);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/health", (c) => c.json({ ok: true }));

export default app;
