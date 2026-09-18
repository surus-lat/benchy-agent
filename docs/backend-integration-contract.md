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

### Visibility rule: org-wide (decided)

**Benchmarks, runs, and datasets are visible to the whole organization**, not
just their author. An org is a university or any other institution.

So the read scope is the org, and the author is attribution:

```ts
// Reads: scope by org.
.where(eq(benchmarks.orgId, session.user.orgId))

// Writes: stamp both.
{ userId: session.user.id, orgId: session.user.orgId, ... }
```

Store `userId` on every row anyway — you need it for "who made this", for
audit, and for any future per-user view. But no read path should filter on
`userId` alone.

**Every query must be scoped by `orgId`.** There is no row-level security
here; a missing `where orgId = ?` is a cross-tenant leak, and with org-wide
reads that is the only barrier between two universities' data.

One consequence worth deciding on early: org-wide visibility means there is no
private or draft state — a half-finished benchmark is visible to colleagues the
moment it exists. If researchers should be able to work before publishing to
their org, add a `status` (`draft` / `published`) column now and filter on it,
rather than bolting privacy on later.

## The agent is user-specific and conversation-specific

Avoid the word "session" for anything the agent owns — it already means the
login cookie here, and conflating the two causes real bugs. Use
**conversation**.

- A **session** is authentication state: a row in better-auth's `session`
  table, carried by a cookie, rotating and expiring on its own schedule, one
  per browser. It answers only "who is this request from".
- A **conversation** is one chat thread with the agent. A user can have many,
  and starts a new one whenever they want a fresh thread. It outlives any
  login session.

So: **never key conversation state on the session id.** Sessions rotate,
expire, and multiply across devices; a researcher's chat history would scatter
or silently vanish. Key on `user.id`, and give conversations their own ids.

The model the product wants:

- The agent always knows *which user* is asking — from `session.user.id`.
- The agent always knows *which conversation* it is in — from the conversation
  id on the request.
- A new chat is a new conversation row, same user.
- The agent may read that user's other conversations when it needs broader
  context — that is allowed, because it is the same person. It is a
  deliberate product choice, not an accident of the schema.

Shape to follow:

```ts
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => user.id),
  orgId: text("orgId").notNull().references(() => orgs.id),
  // Set when the chat is about a specific benchmark; null for a general chat.
  benchmarkId: text("benchmarkId"),
  title: text("title"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const conversationMessages = sqliteTable("conversationMessages", {
  id: text("id").primaryKey(),
  conversationId: text("conversationId")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role", {
    enum: ["user", "assistant", "system", "tool"],
  }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});
```

Two scoping rules, and they are different on purpose:

- **Conversations are per-user.** Load them with
  `where(eq(conversations.userId, session.user.id))`. One researcher does not
  read a colleague's chats, even inside the same org.
- **The benchmarks the agent reasons over are per-org** (see the visibility
  rule above). The agent acting for user X may read any benchmark belonging to
  X's org — and must never read another org's.

`orgId` is still stamped on `conversations` so that a chat can be traced to an
institution and cleaned up if a user moves or an org is removed. It is not the
read filter for conversations.

Long benchmark runs are a separate problem and do not belong in a request
handler at all: a Worker request's wall-clock budget is far below a real
benchmark. Treat the engine's execution model as its own design decision.

## Where the agent runs, and why not the Cloudflare Agents SDK

Cloudflare publishes an Agents SDK (`agents`) — persistent, stateful agents on
Durable Objects. It is a good product and it is **not** the right choice here,
for a reason that is not about quality:

- The Agents SDK is **TypeScript**, running inside Workers on Durable Objects.
- Hermes is **Python** (`requires-python >=3.11,<3.14`, Rust-backed
  transitives like pydantic-core, a Dockerfile and docker-compose).

They are alternatives, not complements. Nothing runs Hermes "inside" the
Agents SDK. Workers' Python support is Pyodide-based and will not run Hermes
either — it needs real wheels, a filesystem, and subprocesses. Choosing the
Agents SDK therefore means rewriting the agent in TypeScript and giving up the
reason Hermes was chosen: its skills system, learning loop, and
provider-agnostic model switching.

The Agents SDK would be the right answer for an agent written from scratch in
TypeScript. That is not this project.

**So: the Worker is the front door; Hermes runs as a container behind it.**
The Worker already owns authentication, D1, and CORS. It authenticates the
request, then calls Hermes over plain HTTP.

### The rule that keeps this reversible

Make the boundary **plain authenticated HTTP from the Worker to Hermes,
passing `userId` and `conversationId`**. Nothing else crosses it. Keep that
boundary clean and *where* Hermes runs stays a deployment decision you can
revisit — not an architecture you are married to.

Concretely, that means: Hermes does not talk to D1 directly, does not read the
session cookie, and does not make authorization decisions. The Worker has
already established who the caller is and which org they belong to; it passes
that down as trusted input. Hermes is a compute service, not a second security
boundary.

### Where the credits go: Bedrock for inference, Cloudflare for everything else

AWS sponsored this project with credits, and **Bedrock usage counts against
those credit terms** (confirmed with the sponsor). That decides the split:

- **Model inference runs on AWS Bedrock**, paid with credits.
- **Everything else stays on Cloudflare** — the Worker, D1, Pages.
- **Hermes runs wherever is cheapest to operate**, which is now a small,
  reversible decision rather than a strategic one.

The reasoning, because it is easy to get backwards: in an agent product,
inference dwarfs every other line item. Hermes doing tool calls and synthetic
dataset generation for a cohort of researchers burns real money in tokens; the
container running it costs tens of dollars a month. Spending sponsor credits
on the container while paying cash for tokens would be optimising the small
number.

Hermes supports this directly — `plugins/model-providers/bedrock/` is a
first-class provider (one of ~28), authenticating through the AWS SDK
credential chain rather than env vars, so it is standard IAM. Pointing the
agent at Bedrock is configuration, not an integration project, and no
LiteLLM-style proxy is needed in between.

There is a standing requirement that the system run on AWS within a few
months. Note that routing inference through Bedrock may already satisfy it,
since that is where nearly all the spend is. If compute itself must relocate,
**AWS App Runner** is the service closest to a Railway-style experience —
point it at a container image, get HTTPS and autoscaling, skip the
ECS/ALB/VPC ceremony. Because the Worker talks to Hermes over plain
authenticated HTTP and conversation state lives in D1, that relocation is a
deployment change.

The Cloudflare Agents SDK and Cloudflare Containers are both ruled out: the
first for the language mismatch described above, the second because it is in
beta with no SLA and is not where an agent runtime belongs during a launch.

### Which system owns conversation state

This matters more than the hosting question, and it is easy to get wrong,
because Hermes ships its own memory system — sessions, FTS5 session search,
skills, user modeling. Our D1 schema also wants to own conversations. Two
systems both believing they are the source of truth for "what did this user
say" will hurt.

The split:

- **D1 owns the conversation record** — id, owner, org, title, which benchmark
  it is about. This is what the UI lists, and what has to be multi-tenant-safe.
- **Hermes owns its internal working memory** for a conversation, keyed by the
  `conversationId` we hand it.
- **Do not try to reconcile the two memory models before launch.**

If that split turns out wrong, you have duplicated a little storage, which is
cheap. The reverse — letting Hermes own the multi-tenant data — puts org
isolation inside a system that was not designed around our org model, which is
not cheap.

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
