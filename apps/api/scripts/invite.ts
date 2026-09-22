import { execFileSync } from "node:child_process";
import {
  slugify,
  generateInviteToken,
  generateId,
  escapeSqlString,
  buildUserExistsSql,
  assertNoExistingUser,
} from "./invite-lib";
import { d1Execute, extractResultRows } from "./d1";

const INVITE_TTL_DAYS = 7;
const FROM_ADDRESS = "invites@getbenchy.lat";
const APP_BASE_URL = "https://getbenchy.lat";

function parseArgs(argv: string[]): { org: string; email: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (!flag || value === undefined) {
      throw new Error('Usage: pnpm invite --org "<name>" --email <email>');
    }
    args[flag] = value;
  }
  if (!args.org || !args.email) {
    throw new Error('Usage: pnpm invite --org "<name>" --email <email>');
  }
  return { org: args.org, email: args.email.toLowerCase() };
}

function refuseIfUserExists(email: string): void {
  const raw = d1Execute(buildUserExistsSql(email));
  const rows = extractResultRows(raw, "checking for an existing account");
  assertNoExistingUser(email, rows);
}

function findOrgIdBySlug(slug: string): string | null {
  const raw = d1Execute(
    `SELECT id FROM orgs WHERE slug = '${escapeSqlString(slug)}'`,
  );
  const rows = extractResultRows(raw, "looking up an org by slug");
  const row = rows[0];
  if (row === undefined) return null;
  if (typeof row.id !== "string") {
    throw new Error(
      `Unexpected row shape from org lookup: ${JSON.stringify(row)}`,
    );
  }
  return row.id;
}

function createOrg(name: string, slug: string): string {
  const id = generateId("org");
  const now = Math.floor(Date.now() / 1000);
  d1Execute(
    `INSERT INTO orgs (id, name, slug, createdAt) VALUES ('${id}', '${escapeSqlString(
      name,
    )}', '${escapeSqlString(slug)}', ${now})`,
  );
  return id;
}

function createInvite(orgId: string, email: string): string {
  const id = generateId("invite");
  const token = generateInviteToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + INVITE_TTL_DAYS * 24 * 60 * 60;
  d1Execute(
    `INSERT INTO invites (id, orgId, email, token, status, createdAt, expiresAt) VALUES ('${id}', '${orgId}', '${escapeSqlString(
      email,
    )}', '${token}', 'pending', ${now}, ${expiresAt})`,
  );
  return token;
}

function markAccessRequestInvited(email: string): void {
  d1Execute(
    `UPDATE accessRequests SET status = 'invited' WHERE email = '${escapeSqlString(
      email,
    )}' AND status = 'pending'`,
  );
}

function sendInviteEmail(email: string, orgName: string, token: string) {
  const link = `${APP_BASE_URL}/accept-invite?email=${encodeURIComponent(
    email,
  )}&token=${token}`;
  execFileSync("npx", [
    "wrangler",
    "email",
    "sending",
    "send",
    "--from",
    FROM_ADDRESS,
    "--to",
    email,
    "--subject",
    `You're invited to Benchy (${orgName})`,
    "--text",
    `You've been invited to join ${orgName} on Benchy.\n\nSign in with this email address here: ${link}\n\nThis invite expires in ${INVITE_TTL_DAYS} days.`,
  ]);
}

function main() {
  const { org, email } = parseArgs(process.argv.slice(2));
  const slug = slugify(org);

  // Before anything is written: an invite for someone who already has an
  // account can never be accepted, and creating the org first would leave a
  // stray org behind when this refuses.
  refuseIfUserExists(email);

  let orgId = findOrgIdBySlug(slug);
  if (!orgId) {
    orgId = createOrg(org, slug);
    console.log(`Created org "${org}" (${slug})`);
  } else {
    console.log(`Using existing org "${org}" (${slug})`);
  }

  const token = createInvite(orgId, email);
  markAccessRequestInvited(email);
  sendInviteEmail(email, org, token);
  console.log(`Invite sent to ${email}. Token (for manual testing): ${token}`);
}

try {
  main();
} catch (err) {
  // Print a clean message instead of letting Node dump an uncaught-exception
  // stack trace — this is the only path a bad invocation (e.g. no args) or a
  // wrangler/D1 surprise takes, so it needs to read like a tool error, not a
  // crash.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
