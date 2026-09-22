import { env, exports } from "cloudflare:workers";
import { beforeEach, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import { createAccessRequestsApp } from "../src/access-requests";
import { verifyTurnstile } from "../src/turnstile";

// Cloudflare's documented test secrets: these hit the real siteverify
// endpoint and return deterministic results for any token.
const ALWAYS_PASS = "1x0000000000000000000000000000000AA";
const ALWAYS_FAIL = "2x0000000000000000000000000000000AA";

const db = drizzle(env.DB, { schema });
const passing = createAccessRequestsApp({ db, turnstileSecret: ALWAYS_PASS, notify: null });
const failing = createAccessRequestsApp({ db, turnstileSecret: ALWAYS_FAIL, notify: null });

const valid = {
  orgName: "Stanford",
  email: "Ana@Stanford.EDU",
  name: "Ana",
  message: "We run an NLP lab.",
  turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
};

function post(app: ReturnType<typeof createAccessRequestsApp>, body: unknown) {
  return app.request("/api/access-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  await db.delete(schema.accessRequests);
});

it("stores the request with a lowercased email", async ({ expect }) => {
  const res = await post(passing, valid);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const rows = await db.select().from(schema.accessRequests);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    orgName: "Stanford",
    email: "ana@stanford.edu",
    name: "Ana",
    status: "pending",
  });
});

it("is idempotent per email and does not reveal the duplicate", async ({ expect }) => {
  expect((await post(passing, valid)).status).toBe(200);
  const again = await post(passing, { ...valid, orgName: "Stanford again" });
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ ok: true });

  const rows = await db.select().from(schema.accessRequests);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.orgName).toBe("Stanford");
});

it("rejects an invalid body with 400 and stores nothing", async ({ expect }) => {
  const res = await post(passing, { ...valid, orgName: "", email: "not-an-email" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { code: string }).code).toBe("INVALID_BODY");
  expect(await db.select().from(schema.accessRequests)).toHaveLength(0);
});

it("rejects a missing Turnstile token with 400", async ({ expect }) => {
  const { turnstileToken: _omit, ...noToken } = valid;
  expect((await post(passing, noToken)).status).toBe(400);
});

it("rejects malformed JSON with 400", async ({ expect }) => {
  expect((await post(passing, "{not json")).status).toBe(400);
});

it("refuses when Turnstile fails and stores nothing", async ({ expect }) => {
  const res = await post(failing, valid);
  expect(res.status).toBe(403);
  expect(((await res.json()) as { code: string }).code).toBe("TURNSTILE_FAILED");
  expect(await db.select().from(schema.accessRequests)).toHaveLength(0);
});

it("verifyTurnstile reports a failure with error codes", async ({ expect }) => {
  const verdict = await verifyTurnstile({ secret: ALWAYS_FAIL, token: "anything" });
  expect(verdict.ok).toBe(false);
  expect(verdict.errorCodes.length).toBeGreaterThan(0);
});

it("is mounted on the Worker's default export", async ({ expect }) => {
  const res = await exports.default.fetch("https://example.com/api/access-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(valid),
  });
  expect(res.status).toBe(200);
  expect(await db.select().from(schema.accessRequests)).toHaveLength(1);
});
