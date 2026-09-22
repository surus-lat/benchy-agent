import { Hono } from "hono";
import { z } from "zod";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import { verifyTurnstile } from "./turnstile";

type Db = DrizzleD1Database<typeof schema>;

export type AccessRequestsDeps = {
  db: Db;
  turnstileSecret: string;
  // Owner notification. Best-effort: a failed send never fails the request,
  // and `pnpm access-requests` lists everything regardless.
  notify: { email: SendEmail; to: string; from: string } | null;
};

const bodySchema = z.object({
  orgName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  name: z.string().trim().max(200).optional(),
  message: z.string().trim().max(2000).optional(),
  turnstileToken: z.string().min(1).max(2048),
});

function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "req_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createAccessRequestsApp(deps: AccessRequestsDeps) {
  if (!deps.turnstileSecret) {
    throw new Error(
      "TURNSTILE_SECRET_KEY is not set. Set it in apps/api/.dev.vars locally " +
        "(Cloudflare's test secret works) or via `wrangler secret put TURNSTILE_SECRET_KEY`.",
    );
  }

  const app = new Hono();

  // Public and unauthenticated: this is how a university asks to be onboarded.
  // It never creates an org or an invite -- the owner does that with the CLI.
  app.post("/api/access-requests", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_JSON" }, 400);
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { code: "INVALID_BODY", fields: parsed.error.issues.map((i) => i.path.join(".")) },
        400,
      );
    }
    const { orgName, email, name, message, turnstileToken } = parsed.data;

    const verdict = await verifyTurnstile({
      secret: deps.turnstileSecret,
      token: turnstileToken,
      remoteip: c.req.header("cf-connecting-ip") ?? undefined,
    });
    if (!verdict.ok) return c.json({ code: "TURNSTILE_FAILED" }, 403);

    // One row per email. A repeat submission is a silent no-op with the same
    // 200, so the endpoint cannot be used to learn who has already applied.
    const inserted = await deps.db
      .insert(schema.accessRequests)
      .values({
        id: requestId(),
        orgName,
        email: email.toLowerCase(),
        name: name || null,
        message: message || null,
        status: "pending",
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: schema.accessRequests.email })
      .returning({ id: schema.accessRequests.id });

    if (inserted.length > 0 && deps.notify) {
      try {
        await deps.notify.email.send({
          to: deps.notify.to,
          from: { email: deps.notify.from, name: "Benchy" },
          subject: `Access request: ${orgName}`,
          text:
            `${name || "Someone"} <${email.toLowerCase()}> requested access for "${orgName}".\n\n` +
            (message ? `Message:\n${message}\n\n` : "") +
            `Review: pnpm access-requests\nApprove: pnpm invite --org "${orgName}" --email ${email.toLowerCase()}`,
        });
      } catch (err) {
        console.error("access-request notification failed", err);
      }
    }

    return c.json({ ok: true });
  });

  return app;
}
