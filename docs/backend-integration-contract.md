# Benchy backend: integration contract

Written for an engineer or agent building a new backend subsystem (the benchy
engine, or the benchy agent) on top of the identity foundation that already
exists in this repo. It assumes no prior context on this codebase.

Status as of 2026-09-18: the identity/multi-tenancy foundation is built and
tested. The engine and the agent are **not** built, and have no spec yet. This
document is the contract between them and what exists.

## Start here: what to build, in what order

**The stack, to begin with: Cloudflare (Pages + Workers + D1) for the web tier
and all authorization; Railway for one Hermes container per organization;
Together AI for inference.** Everything else in this document elaborates that.
AWS and Bedrock appear only under "Swapping Together → Bedrock later" and are
not part of what you build now.

Everything below is reference. This is the path through it.

1. **Read** "Authenticating a request", "The identity model", "Adding tables",
   and "Visibility rule" — that is the world you are building inside.
2. **Add the tables** `conversations`, `conversationMessages` (shapes in "The
   agent is user-specific and conversation-specific") and `orgAgentEndpoints`
   (shape in "The Worker side"). Generate and commit the migration.
3. **Build the agent image** under `apps/agent/`: `FROM` Hermes's image, core
   skills at `/opt/benchy/skills` (root-owned, read-only), a pinned
   `config.yaml` (Together via `custom` provider, `platform_toolsets.api_server`,
   `skills.external_dirs`), and an entrypoint pre-step that runs the boot
   guards and fail-fast checks. All of it is specified under "How the per-org
   Hermes is configured".
4. **Run one instance locally** with Docker against Together. Confirm
   `GET /v1/toolsets` shows exactly the pinned tools and no `terminal`; do one
   manual `POST /api/sessions` then `POST /api/sessions/{id}/chat`.
5. **Worker routes** in `apps/api`: create conversation, send a turn, list
   conversations, list messages — the exact request path is under "The Worker
   side: routing a request to the right org's Hermes", including the
   per-conversation turn lock.
6. **Provision org #1** by hand following "Provisioning a new organization".
7. The chat UI in `apps/web` is a separate track; it calls only the Worker.

Three things not to do, each explained later: no second Worker; the browser
never calls Hermes; Hermes never touches D1 or makes an authorization
decision.

## What exists, and what doesn't

Built, tested, merged to `main`:

- A pnpm monorepo: `apps/web` (Vite/React frontend), `apps/api` (Cloudflare
  Worker, Hono), `packages/db` (Drizzle schema + D1 migrations).
- Authentication via better-auth on Cloudflare D1: magic link + Google OAuth.
- Invite-only signup, enforced server-side, and a CLI that mints invites.
- One org per user (universities are the orgs).

Not built, no spec, deliberately out of scope of the above:

- The benchy engine (running benchmarks).
- The benchy agent (LLM-assisted YAML editing and synthetic dataset building).
- Any table for benchmarks, runs, datasets, or agent conversations.
- Any deployment. Nothing has ever been deployed: no Cloudflare resources,
  no Railway services, no Together AI key (see "Deferred" below).

Authoritative documents:

- `docs/superpowers/specs/2026-09-17-identity-multitenancy-design.md` — the
  design and the decisions it locks in.
- `docs/superpowers/plans/2026-09-17-identity-multitenancy.md` — the
  implementation plan, including a "Deferred: needs your Cloudflare account"
  section listing everything not yet provisioned.

## Running it

```bash
pnpm install                                  # repo root
pnpm --filter @benchy/api db:migrate:local    # apply migrations to local D1
pnpm --filter @benchy/api dev                 # Worker on :8787
pnpm --filter @benchy/web dev                 # frontend on :21707
pnpm --filter @benchy/api test                # Workers suite
pnpm --filter @benchy/api test:scripts        # Node-side suite
```

And one local Hermes instance, so the agent path can be exercised end to end
without Railway (the image is the one you build under `apps/agent/`; see the
per-org configuration section for what it must contain):

```bash
docker build -t benchy-agent apps/agent
docker run --rm -p 8642:8642 \
  -v benchy-dev-org:/opt/data \
  -e API_SERVER_ENABLED=true -e API_SERVER_HOST=0.0.0.0 -e API_SERVER_PORT=8642 \
  -e API_SERVER_KEY=dev-key-change-me \
  -e TOGETHER_API_KEY=... \
  benchy-agent
curl -s -H "Authorization: Bearer dev-key-change-me" http://localhost:8642/v1/toolsets
```

Then point the local Worker at it: `wrangler secret put AGENT_KEY_DEV`
(value `dev-key-change-me`, or add it to `.dev.vars`) and insert an
`orgAgentEndpoints` row for your dev org with `baseUrl =
"http://localhost:8642"` and `apiKeyRef = "AGENT_KEY_DEV"`.


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
apps/agent/              (you create this) the Hermes image: Dockerfile,
  skills/                core benchy skills (source of /opt/benchy/skills)
  config.yaml            pinned Hermes config baked into the image
  entrypoint-pre.sh      boot guards, runs as root before the privilege drop
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

The full benchmark and run model belongs to the engine spec, which does not
exist yet. The agent needs only this minimum to exist now — a benchmark a
conversation can be *about*:

```ts
export const benchmarks = sqliteTable("benchmarks", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => user.id),   // author
  orgId: text("orgId").notNull().references(() => orgs.id),     // read scope
  title: text("title").notNull(),
  // Recommended from day one (see the visibility rule below); not yet a
  // product decision. Filter reads on it if you include it.
  status: text("status", { enum: ["draft", "published"] })
    .notNull()
    .default("draft"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});
```

Follow the same shape — text id, `userId` for attribution, `orgId` for
scope, unix-second timestamps — for every table you add.

### Visibility rule: org-wide (decided)

**Benchmarks, runs, and datasets are visible to the whole organization**, not
just their author. An org is a university or any other institution.

So the read scope is the org, and the author is attribution:

```ts
// `orgId` is the value resolved by the guard in "Authenticating a request"
// (cast + null check) — `session.user.orgId` alone does not typecheck.

// Reads: scope by org.
.where(eq(benchmarks.orgId, orgId))

// Writes: stamp both.
{ userId: session.user.id, orgId, ... }
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
  benchmarkId: text("benchmarkId").references(() => benchmarks.id),
  // The session id inside the org's Hermes instance that this conversation
  // maps to. Created via Hermes's sessions API when the conversation starts.
  hermesSessionId: text("hermesSessionId"),
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

### Which system owns conversation state

This matters more than the hosting question, and it is easy to get wrong,
because Hermes ships its own memory system — sessions, FTS5 session search,
skills, user modeling. Our D1 schema also wants to own conversations. Two
systems both believing they are the source of truth for "what did this user
say" will hurt.

The split:

- **D1 owns the conversation record** — id, owner, org, title, which benchmark
  it is about. This is what the UI lists, and what has to be multi-tenant-safe.
- **Hermes owns its internal working memory** for a conversation, under the
  Hermes `session_id` that the row's `hermesSessionId` points at.
- **Do not try to reconcile the two memory models before launch.**

If that split turns out wrong, you have duplicated a little storage, which is
cheap. The reverse — letting Hermes own the multi-tenant data — puts org
isolation inside a system that was not designed around our org model, which is
not cheap.

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

Make the boundary **plain authenticated HTTP from the Worker to Hermes**:
the Worker chooses *which org's instance* to call, addresses *which Hermes
session* in the URL, and carries speaker attribution in a per-turn
`system_message`. Nothing else crosses it. Keep that boundary clean and
*where* Hermes runs stays a deployment decision you can revisit — not an
architecture you are married to.

Concretely, that means: Hermes does not talk to D1 directly, does not read the
session cookie, and does not make authorization decisions. The Worker has
already established who the caller is and which org they belong to; it passes
that down as trusted input. Hermes is a compute service, not a second security
boundary.

### Runtime topology: Cloudflare + Railway + Together AI

This is decided. Build against it.

```
Browser (researcher)
  │  ONE origin: https://benchy-agent.pages.dev today,
  │  https://getbenchy.lat once its nameservers point at Cloudflare
  ▼
Cloudflare Pages (apps/web)          serves the SPA; a Pages Function proxies
  │  /api/* → the Worker over a Service Binding (apps/web/functions/api/[[path]].ts)
  ▼
Cloudflare Worker `benchy-api` (apps/api, Hono)   no public URL of its own
  • better-auth: magic link (Google off until real OAuth creds), invite-only
  • D1 `benchy-db`: users, orgs, invites, conversations, benchmarks
  • THE ONLY authorization boundary
  │
  │  server-to-server HTTPS, per-org bearer key, never from the browser
  │  routed to THAT ORG's instance; body carries message + speaker attribution
  ▼
Hermes, one container PER ORGANIZATION (Railway)
  • unmodified Hermes in API-server mode (`hermes gateway`)
  • full skills / memory / learning loop, scoped to the org
  • holds NO authorization logic; Worker picks the org's instance
  │
  │  HTTPS, OpenAI-compatible, Bearer TOGETHER_API_KEY
  ▼
Together AI                          https://api.together.xyz/v1
  (later: AWS Bedrock — see the swap procedure below)
```

Four components, four owners:

| Component | Runs on | Owns | Must never |
|---|---|---|---|
| `apps/web` | Cloudflare Pages (project `benchy-agent`) | UI, `/api/*` proxy function | Call Hermes directly |
| `apps/api` | Cloudflare Worker `benchy-api` (reachable only via that proxy) | Auth, authorization, D1, conversation records | Run agent logic |
| Hermes (one per org) | Railway | The agent loop, org-scoped memory & skills, model calls | Decide who may see what; be reachable by anything but the Worker |
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

The complexity budget for this project belongs to the core skills, the
per-org image, and the provisioning runbook — not to the host. Pick the host
that disappears.

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
Together's API is OpenAI-compatible. So this is configuration, not code. The
keys are the ones Hermes's own Docker guide uses for OpenAI-compatible
endpoints (`website/docs/user-guide/docker.md:677-680`, `model.base_url` also
read at `hermes_cli/runtime_provider.py:47-74`):

```yaml
# in the image's config.yaml
model:
  provider: custom
  default: "<exact Together model id — resolve at build time, see below>"
  base_url: https://api.together.xyz/v1
  api_key: "__TOGETHER_API_KEY__"   # placeholder, templated at boot — read on
```

**The API key has no environment variable of its own.** The `custom`
provider declares `env_vars=()` — "No fixed key — custom endpoint"
(`plugins/model-providers/custom/__init__.py:65`) — so unlike the named
providers it will not pick the key up from the environment; it has to be in
`model.api_key`. Do not bake it into the image. Set `TOGETHER_API_KEY` as a
Railway service variable and have the entrypoint pre-step substitute it into
the profile's `config.yaml` at boot (a one-line `sed` on the placeholder,
into the copy under `$HERMES_HOME`, never into the image layer). Whether
Hermes expands `${VAR}` syntax inside `model.api_key` is **not** verified —
Hermes's docs only show literal values there — so do not rely on it.

- provider: `custom`
- base URL: `https://api.together.xyz/v1`
- API key: `TOGETHER_API_KEY` (Railway variable) → templated into
  `model.api_key` at boot
- model: `model.default`; see the note immediately below

**Model choice (decided): Qwen 3.8, or Kimi K3.** Pick on quality now.
Those are family names, not API strings — resolve the exact Together model id
from Together's model list when you build the image, and put it in the
`model.default` config value / its environment override, never in code.

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

#### The Worker → Hermes call

The Worker authenticates the researcher, then calls that researcher's org's
Hermes. Hermes trusts what the Worker tells it, because the Worker has already
done the work.

- **Transport:** HTTPS, server-to-server only. The browser never calls
  Hermes. Do not expose any instance URL to the frontend.
- **Authentication between them:** a per-org bearer key. Each org's Hermes
  is started with its own `API_SERVER_KEY`; the Worker holds each key as a
  Worker secret and looks up which one to use from the `orgAgentEndpoints`
  table (below). Hermes rejects mismatches in constant time
  (`api_server.py:897-919`). This is the only thing standing between the
  public internet and an org's agent, since Railway services get a public URL
  by default.
- **Payload:** the Worker sends the user's message plus a per-turn
  `system_message` carrying speaker attribution, to the Hermes session that
  the D1 `conversations` row maps to. The org (and therefore the instance) and
  the researcher's identity come from the verified session, never from the
  client's request body.
- **What Hermes must not do:** no session-cookie parsing, no D1
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

A consequence worth internalising: Hermes has no notion of *which*
researcher is calling beyond the attribution string the Worker writes, so
anyone holding an org's `API_SERVER_KEY` can read and drive every conversation
in that org and claim to be anyone in it. Treat each org key with the same
care as the auth secret, never let it near the frontend bundle, and rotate it
if a Railway collaborator leaves.

#### Railway service shape

- **One service per organization**, all from one shared image. Not one per
  researcher (the cost model to avoid) and not one for everyone (Hermes is
  single-tenant per instance — see the section below). Cost scales with the
  number of universities, not researchers.
- Deployed from a Dockerfile built on Hermes's own, with benchy's curated
  skills added under `/opt/benchy/skills` and a pinned `config.yaml`.
- A Railway **volume per service**, mounted at `$HERMES_HOME` — `/opt/data`
  in Hermes's image (`Dockerfile:290`). It holds the org's memory,
  self-written skills, and Hermes's SQLite state. D1 remains the
  record of which conversations exist and who owns them; the volume is what
  makes the org's agent get better over time.
- Environment variables per service: `API_SERVER_ENABLED`, `API_SERVER_KEY`
  (fresh per org), `API_SERVER_HOST`, `API_SERVER_PORT`, `TOGETHER_API_KEY`.
  Set them as Railway service variables — Hermes reads `API_SERVER_*` from
  the process environment (`api_server.py:745-750`), so no `.env` file needs
  to exist on the volume.
- Plan: Pro ($20/month minimum usage) for the 99.99% availability target.

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

### Hermes is single-tenant per instance — deploy one per organization

An audit of Hermes (https://github.com/NousResearch/hermes-agent — every
`file:line` citation in this document is against commit `2c6e266e8`,
2026-06-19; re-check line numbers if you are on a newer checkout) found that **one Hermes instance cannot safely
serve multiple isolated principals.** Conversations are keyed by session id in
SQLite, but memory, skills, cron, config and the terminal sandbox all root at
a single filesystem home, resolved as ContextVar → `HERMES_HOME` →
`~/.hermes` (`hermes_constants.py:53-108`). Upstream's own answer to multiple
users is one profile per user, each running its own gateway with its own
`API_SERVER_KEY` (`website/docs/user-guide/features/api-server.md`, "Multi-User
Setup with Profiles"; `hermes_cli/profiles.py`).

**Decision: the isolation unit is the organization.** One Hermes container per
university, never one per researcher, never one shared by all. This is a
product decision the team has made explicitly — benchmarks are already
org-visible, so an org-scoped agent memory is consistent with everything else.
It also means **no fork and no stripped-down embedding**: each container runs
the full, unmodified Hermes — skills, memory, learning loop — configured
through its own `.env` and `config.yaml`.

Read the audit findings with that grain in mind. Each was a *per-user* leak
inside one shared home; at org grain most stop being leaks:

- **Memory is shared and goes into every prompt** (`memories/MEMORY.md`,
  `USER.md`, snapshotted per turn — `tools/memory_tool.py:55-57, 150-170`).
  Per org, this is the org's memory. Acceptable. The cost is that Hermes
  models "the user" as a composite of the org's researchers; see "speaker
  attribution" below for the mitigation.
- **Session search spans all messages** (`hermes_state.py:601-624`;
  `search_messages` filters only by source/role, `:3273-3283`). At org grain
  it would let one researcher's agent read a colleague's chats — which
  **conflicts with the per-user conversation rule** above. Resolution: the
  `session_search` toolset is **not** in the API server's pinned toolset, so
  the agent has no tool that crosses conversations. Do not add it back; if
  cross-conversation recall is ever wanted, it must be built on the Worker
  side, filtered by `userId`.
- **Session search can read *other profiles'* databases** via a `profile=`
  argument (`tools/session_search_tool.py:36-40, 134-175`). **Closed by
  topology:** each container holds exactly one profile, so there is nothing
  else on that filesystem to read. Do not co-locate two orgs' homes on one
  disk, or this reopens.
- **Skills are a shared writable directory** (`tools/skills_tool.py:93-94`,
  `skill_manager_tool.py:559-834`). Per org, they are the org's skills and the
  self-improvement loop is the point. See "skills" below for how benchy's
  curated skills coexist with them.
- **The terminal sandbox is one container** for all top-level agents
  (`tools/terminal_tool.py:1002-1034`). Per org this is arbitrary code
  execution shared by an org's researchers — stronger than "can read a
  colleague's benchmark." **Decided: the terminal tool is disabled in every
  org container; see below.**
- **No per-user authorization; single bearer key; `GET /api/sessions` lists
  every session** (`gateway/platforms/api_server.py:750, 1362-1389`). Per
  org: one key per org, held only by the Worker, which is the sole caller and
  already knows which researcher it is acting for. The Worker presents each
  researcher only their own conversations from D1 (conversations are
  per-user; see above). Hermes never sees a browser.

What remains true regardless of grain: Hermes must never be reachable from
anything but the Worker, and the Worker must never let one org's request
reach another org's instance. Both are routing rules, stated concretely below.

### How the per-org Hermes is configured (all configuration, no code)

**HTTP surface.** The API server is a first-class Hermes feature. Set, as
Railway service variables (a profile `.env` works too — same keys):

```
API_SERVER_ENABLED=true
API_SERVER_KEY=<a long random per-org secret>
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
```

Start with `hermes gateway`. It refuses to start without a key, and checks
`Authorization: Bearer` in constant time (`api_server.py:897-919`). Leave
`API_SERVER_CORS_ORIGINS` unset — no browser ever talks to it.

**The endpoint to use:** `POST /api/sessions/{session_id}/chat` — one
synchronous agent turn, returns
`{"session_id", "message": {"role": "assistant", "content"}, "usage"}`
(`api_server.py:1544-1599`). Create the session first with
`POST /api/sessions` (`api_server.py:4178`), and store the returned Hermes
`session_id` on the D1 `conversations` row as `hermesSessionId`. This
is the non-streaming contract decided above. `POST
/api/sessions/{id}/chat/stream` (SSE) exists for later.

**Speaker attribution within an org.** The chat body has no user field; it
accepts `message` plus an optional ephemeral `system_message` (a.k.a.
`instructions`) applied to that turn only (`api_server.py:1561-1563`). The
Worker passes the researcher's identity there on every turn, e.g.
`"The researcher speaking is Ana Pérez (user_01H…). Address them by name."`
This is how Hermes tells org members apart in the moment.

**Also send `X-Hermes-Session-Key: user:<userId>` on every call.** Hermes
defines this header as "a stable per-channel identifier that scopes long-term
memory," independent of the transcript session id
(`api_server.py:936-960`; `api-server.md`, "Long-term memory scoping"). With
the default file-based memory (`MEMORY.md` / `USER.md`) it changes nothing —
that memory stays org-scoped. But with the Honcho memory provider it derives
a **per-researcher** memory scope inside the org's instance, which is exactly
the "composite user" cost accepted elsewhere in this document — so pass it
from day one, and the fix becomes enabling a provider rather than a
migration. Hermes requires API-key auth for the header, so no caller can
guess into another user's scope. Max 256 chars, no control characters.

**Custom skills (benchy's, plus the org's own).** `config.yaml`:

```yaml
skills:
  external_dirs:
    - /opt/benchy/skills      # baked into the image; read-only
```

Per the config reference: external dirs are read-only, skill creation always
writes to the profile's `~/.hermes/skills/`, and local skills take precedence
on a name collision (`agent/skill_utils.py:416`, `cli-config.yaml.example:578`).
So benchy ships its curated skills (edit benchmark YAML, generate synthetic
datasets, run an eval, …) in the image, updates them by rebuilding the image,
and each org's Hermes still grows its own on top. Do not write benchy's skills
into `~/.hermes/skills/` — that directory is the org's, and an image update
must not clobber it. **Who may change which tier, and how that is enforced,
is the next item — read it; the config-level "read-only" is not sufficient.**

**Core skills: benchy-wide, owner-only (decided).** Two tiers of skills, with
different owners and different enforcement:

| Tier | Lives in | Who can change it | How |
|---|---|---|---|
| **Core benchy skills** — manage a benchmark, edit its YAML, generate synthetic data, run an eval | `/opt/benchy/skills` in the image | **Only the system owner** | Edit the source in this repo, rebuild the image, redeploy every org service |
| **Org skills** — whatever an org's Hermes learns or a researcher asks it to save | `$HERMES_HOME/skills` on the org's volume | That org's Hermes, at its users' direction | Hermes's normal skill creation / self-improvement |

Core skills are identical across every org, and no researcher can alter them
through chat. The org tier is untouched — the learning loop stays fully on.

*Why filesystem permissions, not Hermes config.* The config reference calls
`external_dirs` "read-only", but in source that only means **creation goes
local**. `skill_manager`'s `edit`, `patch`, `delete` and `write_file` resolve a
skill's root across local *and* external dirs (`tools/skill_manager_tool.py:
115-134`, `_containing_skills_root`) and carry no external-dir refusal — if
the process can write the file, the agent can edit a core skill. Hermes's
`pinned` flag is not the answer either: it guards **deletion only** and
explicitly permits edits and patches (`skill_manager_tool.py:211-234`). And
the `file` tool has no path denylist beyond device files
(`tools/file_tools.py:69, 286`). So enforcement has to be at the OS:

1. **In the image:** `COPY --chown=root:root skills/ /opt/benchy/skills/`
   then `chmod -R a-w /opt/benchy/skills && chmod -R a+rX /opt/benchy/skills`
   (directories `0555`, files `0444`).
2. **Run as non-root.** Hermes's own Dockerfile already does this: it creates
   `hermes` (uid 10000) and the entrypoint wrapper drops to it via
   `s6-setuidgid` for every subcommand, `gateway` included
   (`docker/main-wrapper.sh:22`). **Never override the entrypoint or start
   command on Railway** — that is the one way to end up root and void this.
3. **Fail fast at boot** with a tiny pre-start check in the image: exit
   non-zero if `id -u` is `0`, or if `test -w /opt/benchy/skills` succeeds.
   A misconfigured container should refuse to serve, not serve unprotected.
4. `terminal` is already disabled (above). Even if it weren't, uid 10000 has
   no `sudo_password` configured and cannot `chmod` root-owned files.

With that, every write into the core tree — from `skill_manager`, from the
`file` tool, from anything — fails with `EACCES` regardless of how Hermes's
tool logic evolves.

*Protections Hermes gives you for free, verified in source:*

- **Name squatting is refused.** `_create_skill` looks the name up across local
  and external dirs and refuses with "A skill named 'X' already exists at …"
  (`skill_manager_tool.py:559-626`, via `_find_skill`). A researcher cannot
  create a local `benchy-eval` to shadow the core one.
- **Ambiguity is refused, not guessed.** If two skills ever share a bare name
  across tiers, loading by that name errors out with the candidate paths
  (`tools/skills_tool.py:1000-1105`) rather than silently picking one.

*Conventions to adopt:*

- Prefix every core skill `benchy-` and reserve the prefix; it makes the tier
  obvious in listings and in the collision error text.
- Core skills are source in this monorepo (default: `apps/agent/skills/`,
  next to the agent image's Dockerfile), so "only the owner" is enforced by
  the repo — branch protection on `main` and a `CODEOWNERS` entry for that
  path (neither exists yet: the builder adds `.github/CODEOWNERS` when
  creating `apps/agent/`; the owner enables branch protection) — and every
  change is a reviewed commit. Rebuilding the image is the
  only path from source to the containers.
- Rebuild-and-redeploy replaces the core tree wholesale and leaves each org's
  volume untouched, so an image update never clobbers what an org has learned.

*On "global" vs "local" skills — Hermes has no such tier.* The only place
"global" appears in Hermes's skills code is `skills.disabled` — a skill can be
disabled *globally* (every platform) or per platform
(`agent/skill_utils.py:381-388`, `hermes_cli/skills_config.py:5-42`). That is
an on/off scope for a skill name, not a storage location and not an ownership
level. Hermes's actual two storage tiers are the ones above:

- **local** — `~/.hermes/skills/`, "primary, read-write", where creation goes
  (`website/docs/user-guide/features/skills.md:278`) → **the org tier**;
- **external** — `skills.external_dirs` → **the core tier**.

So the mapping is the one already specified, and the direction matters: core
= external, org = local. Do not put core skills in `~/.hermes/skills/` — that
is the writable tier by definition.

The docs also state the in-place-edit behaviour plainly, which is why the
tier alone is precedence and not protection (`skills.md:269`): "Existing
skills are modified where they are found, **including skills under
`external_dirs`**, when the agent uses `skill_manage` actions such as `patch`,
`edit`, `write_file`, `remove_file`, or `delete`." Filesystem permissions
remain the control.

*One residual vector, and its guard.* `skill_manage create` refuses a name
that exists in any tier, but the generic `file` tool has no path denylist
(`tools/file_tools.py:69, 286`). If `file` is in the API server's toolset, a
researcher can ask the agent to write `~/.hermes/skills/benchy-eval/SKILL.md`
directly, bypassing `create`. Result: not a silent replacement — bare-name
loading then hits the ambiguity refusal (`skills_tool.py:1085-1105`) — but the
core skill becomes unloadable by name for that org, and the shadow is loadable
by explicit path. Org-local and self-inflicted, but cheap to prevent:

1. **Reserve the names on the volume.** In the benchy image's entrypoint
   pre-step (runs as root, before the wrapper drops to `hermes`), for every
   core skill name create `$HERMES_HOME/skills/<name>/` as an **empty,
   root-owned, mode `0555`** directory if nothing is there yet. Hermes ignores
   a skill dir with no `SKILL.md`, so it causes no collision — and the agent
   cannot write into it. The core skill names are known at image build time,
   which is exactly the set you control.
2. **Sweep legacy-flat shadows at boot.** Hermes also treats any
   `<name>.md` under the skills tree as a candidate (`skills_tool.py:1075-
   1083`). In the same pre-step, remove any file under `$HERMES_HOME/skills`
   whose stem matches a core skill name, and log it. Combined with the
   `benchy-` prefix, "any `benchy-*` name under the org tier" is the rule.

If the agent builder decides the API server does not need the `file` tool at
all (benchmarks edited through a core skill that calls the Worker's API
rather than local files), the vector disappears and the guards are belt and
braces. Either way, implement both — they cost a few lines.

*What this does not protect, so nobody assumes it does:*

- **The model's compliance.** Permissions protect the file, not whether the
  agent follows it. A researcher can still talk the agent into ignoring a
  core skill's instructions in a given turn. That is a prompt-injection
  surface, not a filesystem one, and it is the same for every agent product.
- **Runtime-loaded copies.** Hermes reads core skills into context; a
  researcher can ask the agent to *show* them. They are instructions, not
  secrets — do not put credentials or anything confidential in a skill.

**Terminal tool — DECIDED: disabled.** Omit `terminal` from the API server's
toolset in the image's `config.yaml`. The agent edits YAML and generates
datasets through its own file and skill tools; it does not get a shell. This
is the same for every org container. If a shell is ever needed, the way back
is the sandbox path below — not `backend: local`.

For the record, the backend is configuration
(`cli-config.yaml.example:169-290`): `local`, `ssh`, `docker`, `singularity`,
`modal`, `daytona`. On Railway, `local` would run researchers' commands inside
the org's own container, and `docker` needs docker-in-docker, which Railway
does not offer. **The only acceptable way to re-enable a shell later** is a
cloud sandbox backend — `terminal: { backend: modal }` or `daytona`, Hermes's
native options, each an optional extra in `pyproject.toml` — and it would have
to be the same for every org container. This is a security posture, not a
per-customer preference.

**Toolsets (verified in source).** The API server resolves its tools from
`platform_toolsets.api_server` in `config.yaml`
(`gateway/platforms/api_server.py:1025, 1044` —
`_get_platform_tools(user_config, "api_server")`). So the image's
`config.yaml` pins:

```yaml
platform_toolsets:
  api_server: [file, skills, todo, web]
  # no terminal (disabled, see above). no session_search (would read across
  # researchers' conversations; conversations are per-user). 'file' REQUIRES
  # the boot guards in "Core skills"; drop it if benchmarks are edited via a
  # core skill that calls the Worker instead of local files.
```

`GET /v1/toolsets` on a running instance returns the toolset surface it is
actually exposing (`api_server.py:1237-1268`) — use it to confirm the pin took
effect before the first org goes live, rather than trusting the file.

**Model provider.** As decided above: the `model:` block under "Together AI
configuration in Hermes" — provider `custom`, base URL
`https://api.together.xyz/v1`, key templated into `model.api_key` at boot
from the `TOGETHER_API_KEY` variable, `model.default` set to the resolved
Together id for Qwen 3.8 or Kimi K3. Identical across all org containers.

### The Worker side: routing a request to the right org's Hermes

Add a table in `packages/db/src/schema.ts`:

```ts
export const orgAgentEndpoints = sqliteTable("orgAgentEndpoints", {
  orgId: text("orgId").primaryKey().references(() => orgs.id),
  baseUrl: text("baseUrl").notNull(),     // e.g. https://stanford-agent.up.railway.app
  apiKeyRef: text("apiKeyRef").notNull(), // name of the Worker secret holding this org's API_SERVER_KEY
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});
```

Do not store the org's `API_SERVER_KEY` in D1. Store the *name* of a Worker
secret and resolve it at request time, so a D1 read never yields a credential.

**Routes and payloads (browser ↔ Worker).** All under the existing Hono app,
all behind `sessionMiddleware`, all JSON. The frontend never sees a Hermes
URL, session id, or key.

| Method & path | Request body | Response |
|---|---|---|
| `POST /api/conversations` | `{ "benchmarkId"?: string, "title"?: string }` | `201 { "id", "title", "benchmarkId", "createdAt" }` |
| `GET /api/conversations` | — | `200 { "conversations": [{ "id", "title", "benchmarkId", "updatedAt" }] }` (caller's own only) |
| `GET /api/conversations/:id/messages` | — | `200 { "messages": [{ "id", "role", "content", "createdAt" }] }` |
| `POST /api/conversations/:id/turns` | `{ "message": string }` | `200 { "reply": string, "usage": {...} }` · `409` if a turn is already in flight · `503` if the org has no provisioned instance |

`benchmarkId`, when given, must belong to the caller's org — check it, or a
researcher can attach a chat to another university's benchmark id.

**Creating a conversation** (`POST /api/conversations`, authenticated):

1. Resolve the researcher and `orgId` from the session; 401/403 as above.
2. Look up `orgAgentEndpoints` for the org (see step 4 below for the
   not-provisioned case).
3. `POST {baseUrl}/api/sessions` with `Authorization: Bearer <key>` and
   `X-Hermes-Session-Key: user:<userId>`; take `session_id` from the response.
4. Insert the `conversations` row with `userId`, `orgId`, optional
   `benchmarkId`, and `hermesSessionId = session_id`. If the Hermes call
   failed, do not insert — return the error; a conversation without a Hermes
   session is not a valid state.

**Sending a turn** — the request path, in order, every time:

1. `sessionMiddleware` resolves the researcher; 401 if none.
2. Read `orgId` from the session — never from the request body.
3. Load the `conversations` row by id **and** assert `conversation.userId ===
   session.user.id`; 404 otherwise. (Conversations are per-user.)
4. Look up `orgAgentEndpoints` by that `orgId`; resolve its key from the
   Worker secret it names. A missing row means the org has not been
   provisioned — return a clear error, do not fall back to any default
   instance.
5. `POST {baseUrl}/api/sessions/{conversation.hermesSessionId}/chat` with
   `Authorization: Bearer <key>` and `X-Hermes-Session-Key: user:<userId>`,
   body `{ message, system_message: "<speaker attribution>" }`.
6. Persist the user message and the assistant reply to
   `conversationMessages`; return the reply.

Serialize turns per conversation — two concurrent POSTs to one Hermes session
race (`api_server.py` holds no per-session lock). Either reject a second turn
while one is in flight (return 409 to the client) or queue it; do not let two
through.

### Provisioning a new organization

Creating an org now has a second step beyond the invite CLI. Add to the
runbook:

1. `pnpm invite --org "Stanford" --email …` creates the org row (existing).
2. Create the org's Hermes service on Railway from the shared image, with its
   own volume mounted at `/opt/data`, and env vars: `API_SERVER_*` (fresh
   random key) and `TOGETHER_API_KEY`.
3. `wrangler secret put AGENT_KEY_<ORG_SLUG>` with that key.
4. Insert the `orgAgentEndpoints` row (`baseUrl`, `apiKeyRef =
   "AGENT_KEY_<ORG_SLUG>"`).

Do this by hand for the first universities; automate through Railway's CLI /
GraphQL API once the shape is stable. The image is shared across orgs; the
volume and the secrets are what differ.

### What this costs, honestly

- One always-on Python container per university. At five to twenty
  organizations this is a modest, load-independent floor on Railway; it does
  not scale with researcher count. Revisit around thirty orgs — options then
  include a scale-to-zero host for dormant orgs.
- Composite within-org user model with the default memory backend
  (accepted; removable later by enabling the Honcho provider, since the
  Worker already sends a per-user `X-Hermes-Session-Key`).
- A per-org provisioning step (above).
- No shell for the agent (terminal disabled).

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

## Deployment status (2026-09-18)

Live, single origin **https://getbenchy.lat** (cut over 2026-09-22;
`benchy-agent.pages.dev` now 301s there) — verified end to end through the
public URL: SPA served, `/api/*` proxied to the Worker (`/api/health` is the
external liveness check), and an uninvited magic-link request refused with
`403 NO_PENDING_INVITE`.

Done:
- Cloudflare account **Gradiente Sur** (`625b40d3…`). D1 `benchy-db`
  (`20b0613c-7ce4-4131-9c38-e69c524773e1`, region ENAM) created, bound,
  migrated — 6 app tables live.
- Worker `benchy-api` deployed with secrets `BETTER_AUTH_SECRET` (fresh,
  never recorded), `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (placeholders;
  Google sign-in hidden in the UI). `workers_dev` and preview URLs are off:
  the proxy is the only entry.
- Pages project `benchy-agent`, production branch `main`, deployed from
  `apps/web/dist/public` with the proxy function and `_redirects`.

Done since: nameservers moved to Cloudflare (zone `getbenchy.lat` active),
custom domain attached to the Pages project, `BETTER_AUTH_URL` flipped to
`https://getbenchy.lat`, `pages.dev` → `getbenchy.lat` redirect live.
Email Sending is enabled on `getbenchy.lat` (sender `auth@getbenchy.lat`,
invites from `invites@getbenchy.lat`). The first invite — org `SURUS`,
`francis@surus.lat` — was created and sent on 2026-09-22 via
`pnpm invite`; that run also verified the CLI's `wrangler d1 execute --json`
parsing against real output. Completing that sign-in on
https://getbenchy.lat is the last end-to-end check.

Preview deployments (`<hash>.benchy-agent.pages.dev`) serve the app but
**cannot complete sign-in**: their origin is not in `trustedOrigins`, so
better-auth rejects the `callbackURL` with `INVALID_CALLBACK_URL`. Test auth
on the production alias.

Everything under "Provisioning a new organization" (Railway, Together, the
first org's Hermes) is still to do.
