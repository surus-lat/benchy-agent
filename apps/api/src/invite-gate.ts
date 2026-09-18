import { APIError } from "better-auth/api";
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "@benchy/db";

type Db = DrizzleD1Database<typeof schema>;

const NO_INVITE_MESSAGE =
  "This email has no pending invite. Ask your university admin for one.";

/**
 * A machine-readable code is what turns this rejection into a redirect the
 * login page can render, and it is not optional. Both places better-auth
 * creates a user from an interactive flow — `callbackOAuth` in
 * `api/routes/callback.mjs` and `magicLinkVerify` in
 * `plugins/magic-link/index.mjs` — guard the same way:
 *
 *   if (isAPIError(e) && e.body?.code) redirectWithError(e.body.code, e.body.message)
 *   throw e
 *
 * With no `code`, the `throw e` branch wins and the person is left on a bare
 * 403 at the API origin; with one, they are redirected to `errorCallbackURL`
 * carrying `?error=<code>&error_description=<message>` — the two query
 * parameter names better-auth 1.7.5 uses, and the ones `apps/web`'s login page
 * reads.
 */
const NO_INVITE_CODE = "NO_PENDING_INVITE";

/**
 * Invariant: `invites.email` is required to already be stored lowercased.
 * Nothing here normalizes it on write — the invite-creation CLI (a later
 * task) is what enforces that. This lookup lowercases only the incoming
 * `email` argument to match against it.
 */
export async function findPendingInvite(db: Db, email: string) {
  const [invite] = await db
    .select()
    .from(schema.invites)
    .where(
      and(
        eq(schema.invites.email, email.toLowerCase()),
        eq(schema.invites.status, "pending"),
      ),
    )
    // Secondary tiebreaker: two invites created in the same millisecond
    // (e.g. a bulk-invite) would otherwise have undefined relative order in
    // SQLite, and this function must deterministically pick the same row
    // every time it's called for the same state — `markInviteAccepted` in
    // `databaseHooks.user.create.after` relies on that to flip the same
    // invite that `requireInviteForSignup` in `before` just consumed.
    .orderBy(desc(schema.invites.createdAt), desc(schema.invites.id))
    .limit(1);

  if (!invite) return null;
  if (invite.expiresAt.getTime() < Date.now()) return null;
  return invite;
}

async function userExists(db: Db, email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email.toLowerCase()))
    .limit(1);
  return Boolean(row);
}

/** Authoritative gate: a user row may only be created for an invited email. */
export async function requireInviteForSignup(db: Db, email: string) {
  const invite = await findPendingInvite(db, email);
  if (!invite) {
    throw new APIError("FORBIDDEN", {
      message: NO_INVITE_MESSAGE,
      code: NO_INVITE_CODE,
    });
  }
  return invite;
}

/**
 * Request-time gate. A returning user has no pending invite any more — theirs
 * was accepted at signup — so their existing user row is what lets them back in.
 */
export async function requireInviteOrExistingUser(db: Db, email: string) {
  if (await userExists(db, email)) return;
  if (await findPendingInvite(db, email)) return;
  throw new APIError("FORBIDDEN", {
    message: NO_INVITE_MESSAGE,
    code: NO_INVITE_CODE,
  });
}

export async function markInviteAccepted(db: Db, inviteId: string) {
  await db
    .update(schema.invites)
    .set({ status: "accepted" })
    .where(
      and(
        eq(schema.invites.id, inviteId),
        eq(schema.invites.status, "pending"),
      ),
    );
}
