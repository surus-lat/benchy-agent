import { env } from "cloudflare:workers";
import { beforeEach, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { auth } from "../src/auth";

/**
 * End-to-end signup against Miniflare's D1 — the live wiring, not the helpers.
 *
 * `apps/api/test/invite-gate.test.ts` covers the gate functions in isolation
 * and `magic-link-gate.test.ts` covers the `sendMagicLink` pre-check, but
 * neither proves that `databaseHooks.user.create` is actually wired: that a
 * real signup copies `orgId` off the invite, that the invite flips to
 * `accepted`, or that an uninvited signup is refused at the moment the user
 * row would be written. That last one is the only thing standing between an
 * uninvited stranger and a Google account here, since the OAuth callback has
 * no `sendMagicLink` pre-check in front of it — it reaches
 * `internalAdapter.createUser` directly, exactly as `magicLinkVerify` does
 * below.
 */

const db = drizzle(env.DB, { schema });

/** In `trustedOrigins`, so better-auth's `originCheck` accepts it. */
const APP_ORIGIN = "https://app.benchy.example";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  // Children before parents: session/account reference user, invites and user
  // reference orgs.
  await db.delete(schema.session);
  await db.delete(schema.account);
  await db.delete(schema.verification);
  await db.delete(schema.invites);
  await db.delete(schema.user);
  await db.delete(schema.orgs);
});

async function seedOrg(id = "org_stanford") {
  await db.insert(schema.orgs).values({
    id,
    name: "Stanford",
    slug: id,
    createdAt: new Date(),
  });
  return id;
}

async function seedInvite(orgId: string, email: string, id = "invite_1") {
  const now = new Date();
  await db.insert(schema.invites).values({
    id,
    orgId,
    email,
    token: `token_${id}`,
    status: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 7 * DAY_MS),
  });
  return id;
}

/**
 * Requests a magic link the way the login page does.
 *
 * `signInMagicLink` is declared `requireHeaders: true`, so the headers are not
 * optional — without them the call rejects with "Headers is required" before
 * reaching any of our code. Nothing is stubbed: the `EMAIL` binding is
 * Miniflare's simulated `send_email`, and the real `sendMagicLink` callback
 * (invite pre-check included) runs.
 */
async function requestMagicLink(email: string) {
  return auth.api.signInMagicLink({
    body: { email, callbackURL: `${APP_ORIGIN}/` },
    headers: new Headers(),
  });
}

/**
 * The row better-auth stored for the link it just "emailed".
 *
 * The magic-link plugin writes the token to `verification.identifier`, not to
 * `verification.value` — `value` holds `JSON.stringify({ email, name })`. A
 * row as actually observed in this suite:
 *
 *   {
 *     id:         "omod1tY2cgFezmpAZbaSOcuZ0wdguYOO",
 *     identifier: "ydAfhQzjhZKDzlQnYqyliYMDKSAygMpX",  // <- the token
 *     value:      '{"email":"invited@example.com"}',
 *     expiresAt:  Date, createdAt: Date, updatedAt: Date
 *   }
 *
 * It is the token verbatim because the plugin's `storeToken` option defaults
 * to `"plain"`; had it been `"hashed"`, this column would hold a 64-character
 * sha256 hex digest instead and could not be replayed.
 */
async function readStoredLink() {
  const rows = await db.select().from(schema.verification);
  return rows;
}

type RedirectResult = { location: string };

/**
 * Clicks the emailed link. Returns where the browser would be sent.
 *
 * `magicLinkVerify` signals every outcome by throwing a redirect once a
 * `callbackURL` is present — success to the callback, failure to
 * `errorCallbackURL` (which defaults to the callback) with `?error=` and
 * `?error_description=` appended. Anything that is not a redirect is a real
 * failure and is rethrown rather than swallowed.
 */
async function clickMagicLink(token: string): Promise<RedirectResult> {
  try {
    const json = await auth.api.magicLinkVerify({
      query: { token, callbackURL: `${APP_ORIGIN}/` },
      headers: new Headers(),
    });
    throw new Error(
      `Expected /magic-link/verify to redirect, got JSON: ${JSON.stringify(json)}`,
    );
  } catch (err) {
    const candidate = err as {
      status?: string;
      headers?: Headers;
    };
    if (candidate?.status !== "FOUND") throw err;
    const location = candidate.headers?.get("location");
    if (!location) throw err;
    return { location };
  }
}

it("a real magic-link signup assigns the invite's org and accepts the invite", async ({
  expect,
}) => {
  const orgId = await seedOrg();
  await seedInvite(orgId, "invited@example.com");

  expect(await requestMagicLink("invited@example.com")).toEqual({
    status: true,
  });

  const stored = await readStoredLink();
  expect(stored).toHaveLength(1);
  const [row] = stored;
  // `value` carries the email, `identifier` carries the token — and the token
  // is stored plain (`generateRandomString(32, "a-z", "A-Z")`), not hashed.
  expect(JSON.parse(row!.value)).toMatchObject({ email: "invited@example.com" });
  expect(row!.identifier).toMatch(/^[a-zA-Z]{32}$/);

  const { location } = await clickMagicLink(row!.identifier);
  // Lands back on the app, not on the API that served the callback.
  expect(location).toBe(`${APP_ORIGIN}/`);

  const users = await db.select().from(schema.user);
  expect(users).toHaveLength(1);
  expect(users[0]?.email).toBe("invited@example.com");
  expect(users[0]?.emailVerified).toBe(true);
  // The whole point of the gate: org membership comes from the invite.
  expect(users[0]?.orgId).toBe(orgId);

  const [invite] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.id, "invite_1"));
  expect(invite?.status).toBe("accepted");

  // A session was issued, so this really did complete a sign-in.
  const sessions = await db
    .select()
    .from(schema.session)
    .where(eq(schema.session.userId, users[0]!.id));
  expect(sessions).toHaveLength(1);
});

it("refuses to create a user at signup time when there is no pending invite", async ({
  expect,
}) => {
  const orgId = await seedOrg();
  await seedInvite(orgId, "revoked@example.com");

  await requestMagicLink("revoked@example.com");
  const [row] = await readStoredLink();

  // Revoke the invite between the link being sent and the link being clicked.
  // Verification now reaches `internalAdapter.createUser` with no invite to
  // match — the same state a Google sign-in by a stranger arrives in, and the
  // only gate on that path is `databaseHooks.user.create.before`.
  await db.delete(schema.invites);

  const { location } = await clickMagicLink(row!.identifier);

  // No account, and no orphan session or account row behind it.
  expect(await db.select().from(schema.user)).toHaveLength(0);
  expect(await db.select().from(schema.session)).toHaveLength(0);

  // The refusal is handed back to the app with the gate's own message, rather
  // than dead-ending on a 403 at the API origin.
  const redirect = new URL(location);
  expect(redirect.origin).toBe(APP_ORIGIN);
  expect(redirect.searchParams.get("error")).toBe("NO_PENDING_INVITE");
  expect(redirect.searchParams.get("error_description")).toMatch(
    /no pending invite/i,
  );
});
