import { randomBytes } from "node:crypto";

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generateInviteToken(): string {
  return randomBytes(32).toString("hex");
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * "Does an account already exist for this email?"
 *
 * `user.email` is written lowercased by the invite gate's `user.create.before`
 * hook and the CLI lowercases its `--email` argument, so plain equality is an
 * exact match. `user` is quoted because it is a reserved word in enough SQL
 * dialects that leaving it bare is a trap waiting for the next person who
 * copies this string somewhere else.
 */
export function buildUserExistsSql(email: string): string {
  return `SELECT id FROM "user" WHERE email = '${escapeSqlString(
    email.toLowerCase(),
  )}'`;
}

/**
 * Refuses a second invite for someone who already has an account.
 *
 * A user belongs to exactly one org in v1, and the runtime gate cannot catch
 * this: `databaseHooks.user.create.before` only fires when a user row is
 * created, and the request-time gate deliberately waves existing users
 * through. So a duplicate invite would simply sit `pending` forever, unread
 * and unconsumed, with nobody told. Failing here puts the message in front of
 * the admin who typed the command — the one person who can act on it — and
 * stops the stray row from being written at all.
 */
export function assertNoExistingUser(
  email: string,
  rows: readonly unknown[],
): void {
  if (rows.length === 0) return;
  throw new Error(
    `${email} already has a Benchy account, so no invite was created. ` +
      `A second invite could never be accepted: a user belongs to exactly ` +
      `one org, and the invite gate only runs when an account is first ` +
      `created. To move them to a different org, change their org directly.`,
  );
}
