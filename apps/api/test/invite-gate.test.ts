import { env } from "cloudflare:workers";
import { beforeEach, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import {
  findPendingInvite,
  markInviteAccepted,
  requireInviteForSignup,
  requireInviteOrExistingUser,
} from "../src/invite-gate";

const db = drizzle(env.DB, { schema });

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedOrg(id = "org_stanford") {
  await db.insert(schema.orgs).values({
    id,
    name: "Stanford",
    slug: id,
    createdAt: new Date(),
  });
  return id;
}

async function seedInvite(overrides: {
  id: string;
  orgId: string;
  email: string;
  status?: "pending" | "accepted" | "expired";
  createdAt?: Date;
  expiresAt?: Date;
}) {
  const now = new Date();
  await db.insert(schema.invites).values({
    id: overrides.id,
    orgId: overrides.orgId,
    email: overrides.email,
    token: `token_${overrides.id}`,
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? now,
    expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 7 * DAY_MS),
  });
}

beforeEach(async () => {
  await db.delete(schema.invites);
  await db.delete(schema.user);
  await db.delete(schema.orgs);
});

it("finds nothing when the email was never invited", async ({ expect }) => {
  expect(await findPendingInvite(db, "nobody@example.com")).toBeNull();
});

it("finds a valid pending invite, case-insensitively", async ({ expect }) => {
  const orgId = await seedOrg();
  await seedInvite({ id: "invite_1", orgId, email: "invited@example.com" });

  const invite = await findPendingInvite(db, "INVITED@example.com");
  expect(invite?.id).toBe("invite_1");
  expect(invite?.orgId).toBe(orgId);
});

it("ignores expired invites", async ({ expect }) => {
  const orgId = await seedOrg();
  await seedInvite({
    id: "invite_1",
    orgId,
    email: "invited@example.com",
    expiresAt: new Date(Date.now() - 1000),
  });

  expect(await findPendingInvite(db, "invited@example.com")).toBeNull();
});

it("treats an invite whose expiry is exactly now as not yet expired", async ({
  expect,
}) => {
  const orgId = await seedOrg();
  // `expiresAt` is stored via Drizzle's sqlite `mode: "timestamp"`, which
  // truncates to whole seconds on write (Math.floor(ms / 1000)). Align the
  // boundary to a whole second so the stored value round-trips exactly and
  // the equality this test pins isn't just an artifact of that truncation.
  const boundary = new Date(Math.floor((Date.now() + 60_000) / 1000) * 1000);
  await seedInvite({
    id: "invite_1",
    orgId,
    email: "invited@example.com",
    expiresAt: boundary,
  });

  // The gate's comparison is a strict `<`, so an invite is only expired once
  // the clock reads *past* expiresAt, not at the exact instant it equals it.
  // Pin that boundary deterministically instead of racing the real clock.
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(boundary.getTime());
  try {
    const invite = await findPendingInvite(db, "invited@example.com");
    expect(invite?.id).toBe("invite_1");
  } finally {
    nowSpy.mockRestore();
  }
});

it("ignores already-accepted invites", async ({ expect }) => {
  const orgId = await seedOrg();
  await seedInvite({
    id: "invite_1",
    orgId,
    email: "invited@example.com",
    status: "accepted",
  });

  expect(await findPendingInvite(db, "invited@example.com")).toBeNull();
});

it("picks the most recent invite when several are pending", async ({
  expect,
}) => {
  const orgId = await seedOrg();
  await seedInvite({
    id: "invite_old",
    orgId,
    email: "invited@example.com",
    createdAt: new Date(Date.now() - 3 * DAY_MS),
  });
  await seedInvite({
    id: "invite_new",
    orgId,
    email: "invited@example.com",
    createdAt: new Date(),
  });

  const invite = await findPendingInvite(db, "invited@example.com");
  expect(invite?.id).toBe("invite_new");
});

it("requireInviteForSignup throws when there is no invite", async ({
  expect,
}) => {
  await expect(
    requireInviteForSignup(db, "nobody@example.com"),
  ).rejects.toThrow();
});

it("requireInviteForSignup returns the invite when one is pending", async ({
  expect,
}) => {
  const orgId = await seedOrg();
  await seedInvite({ id: "invite_1", orgId, email: "invited@example.com" });

  const invite = await requireInviteForSignup(db, "invited@example.com");
  expect(invite.orgId).toBe(orgId);
});

it("requireInviteOrExistingUser allows a returning user with no pending invite", async ({
  expect,
}) => {
  const orgId = await seedOrg();
  const now = new Date();
  await db.insert(schema.user).values({
    id: "user_1",
    name: "Returning Researcher",
    email: "returning@example.com",
    emailVerified: true,
    orgId,
    createdAt: now,
    updatedAt: now,
  });

  await expect(
    requireInviteOrExistingUser(db, "returning@example.com"),
  ).resolves.toBeUndefined();
});

it("requireInviteOrExistingUser rejects a stranger", async ({ expect }) => {
  await expect(
    requireInviteOrExistingUser(db, "stranger@example.com"),
  ).rejects.toThrow();
});

it("markInviteAccepted flips exactly that invite", async ({ expect }) => {
  const orgId = await seedOrg();
  await seedInvite({ id: "invite_1", orgId, email: "a@example.com" });
  await seedInvite({ id: "invite_2", orgId, email: "b@example.com" });

  await markInviteAccepted(db, "invite_1");

  const [first] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.id, "invite_1"));
  const [second] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.id, "invite_2"));
  expect(first?.status).toBe("accepted");
  expect(second?.status).toBe("pending");
});
