import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq, like } from "drizzle-orm";
import { schema } from "@benchy/db";
import { auth } from "../src/auth";

// The 6-digit code is now the primary sign-in, so it must hold the same line
// as the magic link: no code for a stranger, and a real code end to end for
// an invited researcher (org copied off the invite, invite accepted, 30-day
// session).

const db = drizzle(env.DB, { schema });
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await db.delete(schema.session);
  await db.delete(schema.account);
  await db.delete(schema.verification);
  await db.delete(schema.invites);
  await db.delete(schema.user);
  await db.delete(schema.orgDomains);
  await db.delete(schema.orgAgentEndpoints);
  await db.delete(schema.orgs);
});

it("never lets an uninvited address in, even holding a valid code", async () => {
  // The request itself succeeds (no enumeration of invited addresses) and no
  // mail goes out; the gate that matters is account creation.
  await auth.api.sendVerificationOTP({ body: { email: "stranger@example.com", type: "sign-in" }, headers: new Headers() });
  const rows = await db.select().from(schema.verification).where(like(schema.verification.identifier, "%stranger@example.com%"));
  const otp = rows[0]?.value.split(":")[0] ?? "123456";
  await expect(
    auth.api.signInEmailOTP({ body: { email: "stranger@example.com", otp }, headers: new Headers() }),
  ).rejects.toThrow(/no pending invite/i);
  expect(await db.select().from(schema.user)).toHaveLength(0);
});

it("signs an invited researcher in with the emailed code", async () => {
  const now = new Date();
  await db.insert(schema.orgs).values({ id: "org_uni", name: "Uni", slug: "uni", createdAt: now });
  await db.insert(schema.invites).values({
    id: "inv_1", orgId: "org_uni", email: "ana@uni.edu", token: "t1", status: "pending",
    createdAt: now, expiresAt: new Date(now.getTime() + 7 * DAY_MS),
  });

  await auth.api.sendVerificationOTP({ body: { email: "ana@uni.edu", type: "sign-in" }, headers: new Headers() });
  const [row] = await db.select().from(schema.verification).where(like(schema.verification.identifier, "%ana@uni.edu%"));
  const otp = row.value.split(":")[0];
  expect(otp).toMatch(/^\d{6}$/);

  const res = await auth.api.signInEmailOTP({ body: { email: "ana@uni.edu", otp }, headers: new Headers() });
  expect(res.user.email).toBe("ana@uni.edu");

  const [created] = await db.select().from(schema.user).where(eq(schema.user.email, "ana@uni.edu"));
  expect(created.orgId).toBe("org_uni");
  const [invite] = await db.select().from(schema.invites).where(eq(schema.invites.id, "inv_1"));
  expect(invite.status).toBe("accepted");

  const [session] = await db.select().from(schema.session).where(eq(schema.session.userId, created.id));
  const days = (session.expiresAt.getTime() - Date.now()) / DAY_MS;
  expect(days).toBeGreaterThan(29);
});

it("rejects a wrong code", async () => {
  const now = new Date();
  await db.insert(schema.orgs).values({ id: "org_uni", name: "Uni", slug: "uni", createdAt: now });
  await db.insert(schema.invites).values({
    id: "inv_1", orgId: "org_uni", email: "ana@uni.edu", token: "t1", status: "pending",
    createdAt: now, expiresAt: new Date(now.getTime() + 7 * DAY_MS),
  });
  await auth.api.sendVerificationOTP({ body: { email: "ana@uni.edu", type: "sign-in" }, headers: new Headers() });
  await expect(
    auth.api.signInEmailOTP({ body: { email: "ana@uni.edu", otp: "000000" }, headers: new Headers() }),
  ).rejects.toThrow();
  expect(await db.select().from(schema.user)).toHaveLength(0);
});
