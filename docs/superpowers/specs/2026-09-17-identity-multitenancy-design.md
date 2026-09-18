# Identity & Multi-Tenancy Foundation — Design

## Context

Benchy is becoming a multi-user product: a UI (this repo), a benchmark-execution
engine ("benchy engine"), and an LLM-assisted YAML/dataset-building helper
("benchy agent"). Initial users are university researchers. All three
subsystems need to know who's asking and which institution they belong to, so
this spec builds that foundation first. The engine and the agent are separate,
later specs — this spec only covers identity, orgs, invites, and sessions.

Everything runs inside Cloudflare: Workers for the API, D1 for the database,
Cloudflare Pages for the frontend, Cloudflare Email Service for transactional
email. No third-party auth or email vendor.

## Decisions this spec locks in

- **Multi-tenancy model**: one org per user (a plain nullable `orgId` column
  on `users`, not a join table). An org models a university.
- **Joining is invite-only**: there is no self-serve signup. An account can
  only be created for an email that has a pending invite.
- **Org creation is platform-admin-only**, done via a local CLI script
  against D1 directly — never a web endpoint. Because of this, the app itself
  has no "platform admin" role/flag; the trust boundary is "can run the
  script with Cloudflare credentials." (Revisit if invite volume outgrows a
  CLI.)
- **Within an org there is one role**: member. No org-admin — all invites are
  sent by the platform admin.
- **Sign-in methods**: magic link (passwordless email) and Google OAuth.
- **Repo layout**: this repo becomes a pnpm-workspace monorepo.

## Architecture

```
benchy-agent/                     (pnpm workspace root)
  apps/
    web/                          ← this frontend, moved from repo root
    api/                          ← new Workers backend (Hono)
  packages/
    db/                           ← Drizzle schema + D1 migrations, shared
  docs/
```

- **apps/api**: a Hono app deployed as a Cloudflare Worker at
  `api.<domain>`. Hono, not Express — Express depends on Node.js APIs that
  don't run natively on Workers; Hono is purpose-built for Workers and is
  the standard pairing with better-auth there. better-auth mounts as a
  sub-router. This Worker is where all future API routes (engine, agent)
  will also live.
- **apps/web**: this Vite/React app, deployed to Cloudflare Pages at
  `app.<domain>`. Unchanged except for the auth additions below.
- **packages/db**: Drizzle ORM schema (SQLite/D1 dialect) and migrations,
  imported by `apps/api`. Kept separate from `apps/api` so the engine/agent
  Workers (future specs) can share the same schema package.
- **Cookies**: better-auth's default cookie session, configured with
  `crossSubDomainCookies: { enabled: true, domain: ".<domain>" }` so one
  session cookie is valid for both `app.` and `api.` subdomains.

## Data model (`packages/db`, D1 + Drizzle)

better-auth owns and migrates its own tables via its Drizzle D1 adapter:

- `users` — extended with one extra column: `orgId` (text, nullable, FK →
  `orgs.id`).
- `sessions`, `accounts`, `verifications` — untouched, as better-auth defines
  them.

App-owned tables:

- `orgs`: `id` (text, primary key), `name`, `slug`, `createdAt`.
- `invites`: `id` (text, primary key), `orgId` (FK → `orgs.id`), `email`,
  `token` (unique, random), `status` (`pending` | `accepted` | `expired`),
  `createdAt`, `expiresAt`.

All primary keys are opaque text IDs (better-auth's default ID generation),
not auto-increment integers — stable values that the engine/agent specs can
use as foreign keys (e.g. a future `benchmark_runs.userId` /
`benchmark_runs.orgId`) without caring how identity is implemented
internally. Ownership scoping for those future tables (per-user vs.
per-org visibility) is a decision for those specs, not this one.

## Invite flow

1. **Admin creates an invite** by running, from their own machine:
   `pnpm invite --org "Stanford" --email researcher@stanford.edu`
   The script:
   - Looks up or creates the `orgs` row (by slugified name) via
     `wrangler d1 execute` — a direct SQL write, no Worker/API call.
   - Inserts an `invites` row: random token, `status = "pending"`,
     `expiresAt = now + 7 days`.
   - Sends the invite email via `wrangler email sending send`. It cannot use
     the Workers `EMAIL` binding, because the script runs on the admin's
     machine rather than inside the Workers runtime. An earlier draft of this
     spec called for the Email Sending REST API with a separately-created,
     scoped Cloudflare API token; going through wrangler instead means the
     admin needs no second credential — both the D1 write and the email ride
     on the same `wrangler login` session they already need in order to
     deploy. Email contains a link:
     `https://app.<domain>/accept-invite?email=<email>&token=<token>`.
   - Refuses, with a clear error and a non-zero exit, if a user already
     exists for that email. Re-inviting an existing member would otherwise
     leave a `pending` invite that nobody ever consumes (see edge cases).

2. **Sign-in is gated on a pending invite, not just org-joining after the
   fact.** A better-auth hook runs before a user is created (magic-link
   verification and Google OAuth callback both go through it):
   - Look up a `pending`, non-expired invite where `invites.email` matches
     the authenticating email (case-insensitive).
   - No match → reject. The person cannot create an account or sign in at
     all. (This is what makes it invite-only rather than merely
     invite-preferred.)
   - Match → allow the sign-in/account-creation to proceed.

3. **On successful first sign-in**, in the same hook (after better-auth
   creates the user row): set `users.orgId` from the matched invite's
   `orgId`, and mark the invite `status = "accepted"`.

4. **The `token` query param** is UX sugar (a direct link that can prefill
   the email field) and a mild anti-enumeration measure — it is not itself
   the authorization check. The authorization check is always "does a
   pending invite exist for this email," so a researcher can also just go
   to the plain login page and use their invited email directly.

5. **Edge cases**: expired invite → same as no invite (rejected, with a
   message telling them to ask the admin to re-invite).

   Re-inviting someone who already has an account → **rejected by the CLI at
   invite-creation time**, not at redemption. This spec originally placed the
   check "in the hook with a clear error", which on implementation turned out
   to be the wrong place twice over: `user.create.before` only fires when a
   user is created, so it never runs for someone who already exists, and even
   if it did, the error would surface to the invitee rather than to the admin
   who made the mistake. Checking in the CLI puts the message in front of the
   person who can act on it, and stops the stray `pending` row from being
   written at all. One org per user remains a hard rule for v1; moving a user
   between orgs is still an out-of-scope admin operation.

## Runtime auth (`apps/api`)

- better-auth configured with:
  - `drizzleAdapter(db, { provider: "sqlite", schema })` against the D1
    binding.
  - `magicLink` plugin. Its `sendMagicLink` callback calls
    `env.EMAIL.send()` (the `send_email` Workers binding — this code path
    runs inside the Worker, unlike the invite script, so it uses the
    binding instead of the REST API).
  - `socialProviders.google` (client ID/secret as Worker secrets).
  - The invite-gate hook described above, wired into both the magic-link
    and Google OAuth user-creation paths.
- Env/secrets needed: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_URL`. The `send_email` and D1
  bindings are configured in `wrangler.jsonc`, not secrets.
- The invite script needs its own local, gitignored credentials (a
  Cloudflare API token scoped to Email Sending + D1, and the D1 database
  ID) — separate from the Worker's secrets, since it never runs inside a
  Worker.

## Frontend (`apps/web`)

- Add better-auth's React client: `useSession()`,
  `signIn.magicLink({ email })`, `signIn.social({ provider: "google" })`.
- One login page/component (email input → magic link, plus a "Sign in with
  Google" button). Handles and surfaces the invite-gate rejection message
  from the API.
- An `/accept-invite` route that reads `email`/`token` from the query
  string, prefills the login page, and otherwise behaves like normal
  sign-in (the token isn't separately verified client-side — the API is the
  source of truth, per above).
- A route guard around the existing wouter `<Router>`: unauthenticated users
  are redirected to `/login`; authenticated users without an `orgId` (should
  not normally happen given the invite gate, but is a valid transient state)
  see a small "contact your admin" message instead of the app shell.

## Testing

- `apps/api`: `@cloudflare/vitest-pool-workers`, with real Miniflare-backed
  D1 (not mocked) for the invite-gate hook, invite acceptance, and
  cross-subdomain cookie config. Exact test list is sized at the
  implementation-plan stage.
- Invite CLI script: a focused test against a local/test D1 instance
  (org-creation idempotency, token generation, expiry).
- Frontend: existing tooling (none currently configured beyond
  `tsc --noEmit`) — route guard and login page get basic component tests if
  a test runner is introduced as part of implementation; not blocking for
  this spec.

## Explicitly out of scope for this spec

- The benchy engine and benchy agent themselves, and any tables for
  benchmarks, runs, or agent calls — separate specs, built on top of
  `users.id` / `orgs.id` as stable foreign keys.
- Any org-admin role, self-serve signup, or multi-org membership — can be
  added later without breaking this schema (`orgId` stays a single nullable
  column; promoting it to a join table if multi-org is ever needed is a
  contained migration).
- A web-based admin UI for creating orgs/invites.
