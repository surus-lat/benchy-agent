# Benchy backend: integration contract

Written for an engineer or agent building a new backend subsystem (the benchy
engine, or the benchy agent) on top of the identity foundation that already
exists in this repo. It assumes no prior context on this codebase.

Status as of 2026-09-17: the identity/multi-tenancy foundation is built and
tested. The engine and the agent are **not** built, and have no spec yet. This
document is the contract between them and what exists.

## What exists, and what doesn't

Built, tested, on branch `feat/identity-multitenancy`:

- A pnpm monorepo: `apps/web` (Vite/React frontend), `apps/api` (Cloudflare
  Worker, Hono), `packages/db` (Drizzle schema + D1 migrations).
- Authentication via better-auth on Cloudflare D1: magic link + Google OAuth.
- Invite-only signup, enforced server-side, and a CLI that mints invites.
- One org per user (universities are the orgs).

Not built, no spec, deliberately out of scope of the above:

- The benchy engine (running benchmarks).
- The benchy agent (LLM-assisted YAML editing and synthetic dataset building).
- Any table for benchmarks, runs, datasets, or agent conversations.
- Any deployment. Nothing has ever been deployed; no Cloudflare resources
  exist yet (see "Deferred" below).

Authoritative documents:

- `docs/superpowers/specs/2026-09-17-identity-multitenancy-design.md` — the
  design and the decisions it locks in.
- `docs/superpowers/plans/2026-09-17-identity-multitenancy.md` — the
  implementation plan, including a "Deferred: needs your Cloudflare account"
  section listing everything not yet provisioned.

## Where your code goes

Add backend routes to the existing Worker at `apps/api`. Do not stand up a
second Worker unless you have a reason the team has agreed on — one Worker
keeps the session cookie, CORS, and D1 binding in one place.

```
apps/api/src/
  index.ts        Hono app. Mounts auth at /api/auth/*, /health. Add routes here.
  auth.ts         better-auth config. Read it; avoid editing it.
  invite-gate.ts  Invite-only enforcement. Don't touch.
packages/db/src/
  schema.ts       Drizzle schema. Your new tables go here.
packages/db/migrations/  Generated SQL. Committed. Never hand-edit.
```

## Authenticating a request

`auth.api.getSession` takes the raw request headers and returns the session or
`null`. The canonical Hono middleware:

```ts
import { createMiddleware } from "hono/factory";
import { auth } from "./auth";

type SessionEnv = {
  Variables: { session: typeof auth.$Infer.Session | null };
};

export const sessionMiddleware = createMiddleware<SessionEnv>(
  async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("session", session);
    await next();
  },
);
```

Then, on any route that needs a user:

```ts
app.post("/api/runs", sessionMiddleware, async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const userId = session.user.id;
  const orgId = (session.user as { orgId?: string | null }).orgId;
  if (!orgId) return c.json({ error: "no organization" }, 403);
  // ...
});
```

Two things to know about that snippet:

- The `orgId` cast is required. `orgId` is a better-auth `additionalFields`
  entry, so it is not in the client's inferred user type.
- `orgId` is declared `input: false` in `auth.ts`. That is a deliberate
  tenant-isolation control: it means a client cannot set its own org through
  better-auth's update-user API. Only server code assigns it, at signup, from
  the invite. Do not add a route that lets a user write their own `orgId`.

## The identity model

- `user.id` — opaque text primary key, better-auth generated. This is the
  stable foreign key for everything you build.
- `user.orgId` — nullable text FK to `orgs.id`. **One org per user**, modeled
  as a plain column, not a join table. In practice it is always set, because
  signup is gated on an invite that carries the org — but it is nullable in
  the schema, so handle null rather than assuming.
- `orgs` — one row per university. Created only by the admin CLI
  (`pnpm invite --org "Stanford" --email someone@stanford.edu`). There is no
  org-creation endpoint and no admin role in the app; the authorization
  boundary is "can run that script with Cloudflare credentials".
- Sign-up is invite-only and enforced in `databaseHooks.user.create.before`,
  which covers every creation path including Google OAuth. You do not need to
  re-check invites in your own routes; if a session exists, that user was
  invited.

## Adding tables

Everything you persist should hang off `user.id`, and usually `orgs.id` too.

1. Add your tables to `packages/db/src/schema.ts`, following the existing
   conventions there: text primary keys, **camelCase column names** (they
   match better-auth's field names one-for-one, do not switch to snake_case),
   and `integer("...", { mode: "timestamp" })` for dates — note that is
   **unix seconds, not milliseconds**.
2. `pnpm --filter @benchy/db generate` — drizzle-kit writes a new migration
   under `packages/db/migrations/`. Commit it.
3. `pnpm --filter @benchy/api db:migrate:local` to apply locally.

Sketch of the shape to follow:

```ts
export const benchmarkRuns = sqliteTable("benchmarkRuns", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => user.id),
  orgId: text("orgId").notNull().references(() => orgs.id),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  // ...
});
```

### The decision you have to make first

**Is a benchmark (or run, or dataset) private to the researcher who made it,
or visible to everyone in their university?** Nothing in the current design
answers this, and it determines every query you write. Store both `userId`
and `orgId` from day one regardless — that keeps either policy available —
but decide the read rule explicitly and write it down before building
queries, because retrofitting org-wide visibility onto per-user rows is a
migration, and retrofitting privacy onto org-wide rows is a leak.

Whatever you choose, **every query must be scoped**. There is no row-level
security here; a missing `where userId = ?` is a cross-tenant data leak.

## Two different things are called "session"

Be careful with this, since you mentioned the agent is session-specific:

- A **better-auth session** is a login session: a row in the `session` table,
  represented by a cookie, expiring on its own schedule, shared across tabs.
  It answers "who is this request from".
- An **agent session** is a conversation or working context. That is yours to
  define; nothing for it exists today.

Do not key agent state on the better-auth session id. Sessions rotate and
expire, and a user with two browsers has two of them — keying on it would
scatter or silently lose a researcher's work. Key on `user.id`, and give your
agent sessions their own id and lifecycle.

For where agent session state lives, on Cloudflare the two sane options are:

- **D1 table** — simplest, queryable, fine for conversation history and
  artifacts. Start here unless you need the other one.
- **Durable Objects** — one instance per agent session, for genuinely stateful
  or concurrent/streaming interaction. More machinery; adopt only if the D1
  shape is actually inadequate.

Long benchmark runs are a third case and do not belong in a request handler at
all: a Worker request has a wall-clock budget far below a real benchmark. Look
at Queues, Workflows, or Containers for the engine, and treat that as its own
design decision.

## Gotchas that will cost you an afternoon

- `compatibility_flags: ["nodejs_compat"]` is required in `wrangler.jsonc` —
  better-auth uses `AsyncLocalStorage`. It is already set; don't remove it.
- Bindings are read at module scope via `import { env } from "cloudflare:workers"`.
  That is intentional and is the pattern better-auth's own Cloudflare docs use.
- `BETTER_AUTH_SECRET` has an explicit fail-fast guard in `auth.ts`. Keep it.
  Without it, better-auth silently falls back to a **publicly known constant
  secret** whenever the variable is unset, and its own guard only fires when
  `NODE_ENV === "production"`, which is never set in a deployed Worker. That
  would mean forgeable sessions with no error.
- Tests run in the Workers runtime via `@cloudflare/vitest-plugin` (NOT the
  older `@cloudflare/vitest-pool-workers`), with `cloudflareTest`,
  `readD1Migrations`, `applyD1Migrations`, and `exports.default.fetch(...)`.
  vitest is pinned to `^4.1.11` — the plugin peer-requires v4 and vitest 5
  breaks it.
- `apps/api/vitest.config.ts` sets `test.include` to `test/**` on purpose.
  Without it the Workers pool swallows the Node-side `scripts/*.test.ts` files
  and runs them in the wrong runtime.
- `invites.email` must be stored lowercased. The lookup lowercases its input
  but nothing normalizes the column, so a mixed-case invite silently never
  matches and locks the researcher out. The CLI enforces this; any new writer
  must too.
- `benchy.example` throughout the codebase is a stand-in for a domain that has
  not been chosen. It is a valid hostname on purpose — better-auth parses
  `baseURL` at startup and an angle-bracket placeholder crashes the Worker.

## Deferred: nothing is provisioned

No Cloudflare resources exist yet — no D1 database, no deployment, no email
domain, no Google OAuth client. The `database_id` in `wrangler.jsonc` is a
placeholder zero-UUID, and `.dev.vars` holds local placeholder credentials.
Everything runs and tests fine offline against Miniflare's simulated D1.

The ordered checklist to make it real is the "Deferred: needs your Cloudflare
account" section at the end of
`docs/superpowers/plans/2026-09-17-identity-multitenancy.md`. Until it is done,
build and test locally and do not assume a deployed API exists.

## Running it

```bash
pnpm install                                  # repo root
pnpm --filter @benchy/api db:migrate:local    # apply migrations to local D1
pnpm --filter @benchy/api dev                 # Worker on :8787
pnpm --filter @benchy/web dev                 # frontend on :21707
pnpm --filter @benchy/api test                # Workers suite
pnpm --filter @benchy/api test:scripts        # Node-side suite
```
