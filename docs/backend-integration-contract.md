# Benchy backend: integration contract

Written for an engineer or agent building a new backend subsystem (the benchy
engine, or the benchy agent) on top of the identity foundation that already
exists in this repo. It assumes no prior context on this codebase.

Status as of 2026-09-18: the identity/multi-tenancy foundation is built and
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

### Runtime topology: Cloudflare + Railway + Together AI

This is decided. Build against it.

```
Browser (researcher)
  │  https://app.<domain>            Cloudflare Pages — apps/web, the React SPA
  │  session cookie, Domain=<domain>
  ▼
Cloudflare Worker                    https://api.<domain> — apps/api, Hono
  • better-auth: magic link + Google, invite-only
  • D1: users, orgs, invites, conversations, benchmarks
  • THE ONLY authorization boundary
  │
  │  server-to-server HTTPS, shared secret, never from the browser
  │  body carries { userId, orgId, conversationId, message }
  ▼
Agent service (Railway)              a Python container you build
  • thin HTTP layer you write
  • embeds Hermes AIAgent + SessionDB as a library
  • holds NO authorization logic
  │
  │  HTTPS, OpenAI-compatible, Bearer TOGETHER_API_KEY
  ▼
Together AI                          https://api.together.xyz/v1
  (later: AWS Bedrock — see the swap procedure below)
```

Four components, four owners:

| Component | Runs on | Owns | Must never |
|---|---|---|---|
| `apps/web` | Cloudflare Pages | UI, session cookie | Call the agent service directly |
| `apps/api` | Cloudflare Workers | Auth, authorization, D1, conversation records | Run agent logic |
| Agent service | Railway | The agent loop, model calls | Decide who may see what |
| Together AI | Together | Inference | — |

#### Why Railway and not AWS

The decision criterion was **simplicity**, explicitly not cost.

AWS App Runner is the least-complex AWS container option, and it still costs
you: an ECR repository plus the docker login/tag/push cycle to get an image
into it, an IAM instance role, secrets via plain env vars or Secrets Manager
with another IAM grant, logs in CloudWatch as a separate console with its own
log-group model, and ACM certificate validation for a custom domain. Three or
four AWS subsystems before the first deploy. Railway is: point it at the repo
or Dockerfile, get HTTPS, set env vars in a UI, read logs in the same place,
roll back in one click.

Starting on Together rather than Bedrock removes the one complication Railway
carried — AWS credentials would otherwise have to live in Railway as
long-lived static IAM keys. With Together it is a single API key.

The complexity budget for this project belongs to the Hermes multi-tenancy
work described above, not to the host. Pick the host that disappears.

Cloudflare compute was evaluated and cannot host this at all: Workers have no
process model (Hermes has ~1,391 subprocess call sites), Python Workers are
Pyodide/WebAssembly and cannot load Hermes's Rust-backed wheels
(`pydantic==2.13.4`, `numpy==2.4.3`), and there is no persistent filesystem
for `HERMES_HOME`. Durable Objects, Pages Functions and Workers for Platforms
are all the same runtime. Cloudflare Containers could run it but is in beta
with no SLA. So the agent tier lives off Cloudflare; the web tier stays on it.

#### Together AI configuration in Hermes

Hermes has **no dedicated Together plugin**. It does have a `custom` provider
(`plugins/model-providers/custom/`) for any OpenAI-compatible endpoint, and
Together's API is OpenAI-compatible. So this is configuration, not code:

- provider: `custom`
- base URL: `https://api.together.xyz/v1`
- API key: `TOGETHER_API_KEY`, set as a Railway environment variable
- model: see the parity rule immediately below

**Model choice (decided): Qwen 3.8, or Kimi K3.** Pick on quality now.

Be aware of what that defers. Bedrock carries Anthropic, Meta, Mistral and
Amazon models — not Qwen or Kimi. So prompts tuned against these will need
re-tuning when the provider swaps, rather than the swap being a config change.
The team has accepted that knowingly; it is a real future cost, not an
oversight, and whoever does the Bedrock migration should budget prompt work
rather than assuming an afternoon.

If that cost later looks unattractive, the escape hatch is to move to a Llama
or Mistral model on Together first, verify the prompts still behave, and only
then switch provider — turning one risky migration into two safe ones.

Keep model ids in configuration. Never hardcode a model id, a provider name,
or a base URL in agent logic. The whole swap should be reachable by changing
environment variables.

#### The Worker → agent service call

The Worker authenticates the researcher, then calls the agent service. The
agent service trusts what the Worker tells it, because the Worker has already
done the work.

- **Transport:** HTTPS, server-to-server only. The browser never calls the
  agent service. Do not expose its URL to the frontend.
- **Authentication between them:** a shared secret. Generate a long random
  value, set it as a Worker secret (`wrangler secret put AGENT_SERVICE_TOKEN`)
  and as a Railway environment variable, and have the agent service reject any
  request whose `Authorization: Bearer` header does not match, in constant
  time. This is the only thing standing between the public internet and an
  unauthenticated agent, since Railway services get a public URL by default.
- **Payload:** the Worker sends `userId`, `orgId`, `conversationId` and the
  user's message. Those values come from the verified session, never from the
  client's request body.
- **What the agent service must not do:** no session-cookie parsing, no D1
  access, no authorization decisions, no deciding which org a user belongs to.
  It is a compute service, not a second security boundary. If it ever needs to
  know something about the user beyond those fields, the Worker passes it.

- **Response shape (decided): one response, not a stream.** For v1 the Worker
  POSTs, waits for the agent to finish its turn, and returns JSON. No SSE, no
  WebSocket, no chunked proxying. This is the simplest contract that works and
  it is what to build against.

  The cost is latency the UI has to absorb: an agent turn doing tool calls can
  take 10-60 seconds, during which the researcher sees nothing but a pending
  state. Make that pending state good — it is the whole perceived
  responsiveness of the feature.

  If streaming is added later it should be a *separate* endpoint rather than a
  change to this one. Workers proxy streaming responses fine, so the ceiling is
  not a platform limit; keeping the non-streaming path intact just means the
  simple case stays simple.

A consequence worth internalising: because the agent service trusts
`userId`/`orgId` blindly, anyone holding the shared secret can impersonate any
researcher. Treat that secret with the same care as the auth secret, keep it
out of the frontend bundle, and rotate it if a Railway collaborator leaves.

#### Railway service shape

- One **shared** service handling all researchers and all conversations. Not
  one per user — that is the cost model to avoid, and it is only achievable
  after the multi-tenancy work listed above.
- Deployed from a Dockerfile. Hermes ships one; you will likely write your own
  thinner image around the embedded library.
- Environment variables: `TOGETHER_API_KEY`, `AGENT_SERVICE_TOKEN`, plus
  whatever `HERMES_HOME` strategy the multi-tenancy work settles on.
- A Railway volume only if the embedded Hermes still needs a writable
  `HERMES_HOME`. Prefer keeping durable state in D1 and treating the container
  disk as scratch, so the service can be redeployed or moved freely.
- Plan: Pro ($20/month minimum usage) for the 99.99% availability target.
  Cost scales with load, not with researcher count.

#### Swapping Together → Bedrock later

When the AWS requirement becomes concrete:

1. Confirm the target Bedrock model is the counterpart of the Together model
   the prompts were tuned against. If it is not, budget prompt work.
2. Create an IAM principal with `bedrock:InvokeModel` scoped to the specific
   model ARNs — nothing broader.
3. If the service is still on Railway, that means an IAM user and a static
   access key pair in Railway's environment. Rotate on a schedule. If the
   service has moved to AWS App Runner by then, use an instance role instead
   and skip static keys entirely.
4. Switch Hermes's provider from `custom` to `bedrock`
   (`plugins/model-providers/bedrock/`, a first-class provider that
   authenticates through the AWS SDK credential chain).
5. Note that AWS credits typically expire. "In a few months" should not drift
   past the expiry date, or the sponsorship is wasted.

### Hermes is not multi-tenant as shipped — read this before building on it

An audit of the Hermes checkout (`/Users/dobleefe/hermes-agent`,
NousResearch/hermes-agent) found that **one Hermes process cannot safely serve
multiple users.** This is not a tuning problem; it is the shape of the tool.
Upstream's own answer to multi-user is one gateway *process per user profile*,
each with "a fully independent HERMES_HOME directory"
(`hermes_cli/profiles.py`, `website/docs/user-guide/features/api-server.md`).

Conversations *are* keyed by session id in SQLite, so transcripts stay
separate. Everything else roots at a single filesystem home, resolved as
ContextVar → `HERMES_HOME` → `~/.hermes` (`hermes_constants.py:53-108`):

- **Memory is shared and goes into every prompt.** One `memories/MEMORY.md`
  and `USER.md` per home, snapshotted into the system prompt on every turn
  (`tools/memory_tool.py:55-57, 150-170`). Run two researchers through one
  process and one's memory lands in the other's context.
- **Session search ignores tenancy** — FTS5 spans all messages with no tenant
  filter (`hermes_state.py:601-624`; `search_messages` filters only by
  source/role, `:3273-3283`). Worse, the tool can read *other profiles'*
  databases via a `profile=` argument (`tools/session_search_tool.py:36-40,
  134-175`), so even one-process-per-tenant leaks unless that tool is off.
- **Skills are a shared writable directory** the agent can create, edit, and
  delete in (`tools/skills_tool.py:93-94`, `skill_manager_tool.py:559-834`),
  and `skill_manager` enumerates other profiles' skills (`:372-435`).
- **The terminal sandbox collapses to one container** shared by all top-level
  agents (`tools/terminal_tool.py:1002-1034`), and cron is one global
  `jobs.json` (`cron/jobs.py:51-53`).
- **Hermes has no per-user authorization.** Its HTTP surface uses a single
  shared bearer key, and `GET /api/sessions` lists every session
  (`gateway/platforms/api_server.py:750, 1362-1389`). Session continuation
  checks only that the session exists (`:1343-1350`).

There is a real HTTP server (`/v1/chat/completions`, `/api/sessions/{id}/chat`)
that builds a fresh `AIAgent` per request and loads history by session id, so
concurrency itself works. Tenancy is what does not.

**What this costs.** Process-per-researcher is the natural unit of isolation
as shipped, which is exactly the cost model we cannot afford — and it still
leaks through cross-profile session search.

### The recommended shape: embed, don't run the gateway

Rather than running Hermes's gateway multi-tenant or one-per-user, **embed
`AIAgent` + `SessionDB(db_path=…)` as a library behind our own thin HTTP
layer**, with the global-state features turned off. That keeps what we
actually need from Hermes — its tool loop and its ~28-provider model
abstraction, Bedrock included — and drops the subsystems that are both the
leak surface and the thing forcing process-per-user.

Concretely, to make one process safely serve everyone:

1. Set a per-request home override (`set_hermes_home_override(tenantHome)`) and
   make `DEFAULT_DB_PATH`, `SKILLS_DIR` (both modules), and `JOBS_FILE` resolve
   lazily instead of binding at import.
2. Thread `userId` through agent creation and add `userId` filters to
   `search_messages` / `list_sessions_rich`; the HTTP path currently never
   passes it.
3. Disable `session_search`'s cross-profile paths, `skill_manager`, and
   `cronjob`; give `terminal` a per-session sandbox or disable it.
4. Remove the three per-turn `os.environ` writes
   (`gateway/session_context.py:97`, `agent/agent_init.py:1035`,
   `gateway/run.py:14583`) — they are process-global state in a concurrent path.
5. Keep our Worker as the only authorization boundary, and add a per-session
   turn lock: two concurrent POSTs to one session currently race.

**Worth saying plainly:** the features Hermes adds over a plain tool loop —
memory, skills, terminal, cron, session search — are precisely the ones this
list disables. If the embedded surface ends up being `AIAgent` plus
`SessionDB`, that is a legitimate use of Hermes as a provider-agnostic agent
loop, but it is not the self-improving agent the README sells, and the team
should decide with open eyes whether that is still the right dependency or
whether building the loop directly is simpler.

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
