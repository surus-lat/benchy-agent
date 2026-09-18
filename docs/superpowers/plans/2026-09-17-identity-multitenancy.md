# Identity & Multi-Tenancy Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `benchy-agent` into a pnpm monorepo with a Cloudflare Workers API that provides invite-only, multi-tenant authentication (magic link + Google OAuth via better-auth on D1), so the frontend, and later the benchy engine/agent, all know who's asking and which university they belong to.

**Architecture:** A Hono Worker (`apps/api`) mounts better-auth against a D1 database, using a shared Drizzle schema package (`packages/db`) that both defines better-auth's own tables and two app-owned tables (`orgs`, `invites`). Sign-up is gated by a `databaseHooks.user.create.before` hook that only allows account creation when a pending invite exists for that email. An admin-only local CLI script writes invites directly to D1 (via `wrangler d1 execute`) and sends the invite email (via `wrangler email sending send`) — neither goes through the Worker. The frontend (`apps/web`, moved from the repo root) gets a better-auth client, a login page, and a route guard.

**Tech Stack:** pnpm workspaces, Hono ^4.13.8, better-auth ^1.7.5 (+ `@better-auth/drizzle-adapter` ^1.7.5), Drizzle ORM ^0.45.2 / drizzle-kit ^0.31.10, Cloudflare D1, Cloudflare Email Service (`send_email` binding + Email Sending REST/CLI), Cloudflare Pages (frontend), `@cloudflare/vitest-plugin` ^1.1.12 for Worker tests, wrangler ^4.134.0.

**Spec:** `docs/superpowers/specs/2026-09-17-identity-multitenancy-design.md`

## Global Constraints

- One org per user: `users.orgId` is a plain nullable column, never a join table (spec §"Decisions this spec locks in").
- Joining is invite-only: an account can only be created for an email with a pending, non-expired invite (spec §"Invite flow", step 2). This is enforced in the Worker, not just in the UI.
- Org creation and invite creation are **CLI-only**, never a web endpoint. No platform-admin role/flag exists anywhere in the app (spec §"Decisions this spec locks in").
- Within an org there is exactly one role: member. No org-admin.
- Sign-in methods: magic link and Google OAuth only, both auto-creating an account on first use, both gated by the same invite check.
- Repo root domain shares cookies across `app.<domain>` and `api.<domain>` via `crossSubDomainCookies`.
- `benchy.example` is a stand-in for the real domain, which isn't chosen yet. It is deliberately a structurally valid hostname (RFC 2606 reserved TLD) because better-auth parses `baseURL` at startup — an angle-bracket placeholder throws `Invalid URL` and takes the whole Worker down. When the real domain exists, swap it in with a single find-and-replace across the repo.
- **Everything in this plan runs locally.** Tests use Miniflare's simulated D1; `wrangler d1 migrations apply --local` needs no Cloudflare account. The `database_id` in `wrangler.jsonc` is a placeholder zero-UUID and only matters for `--remote`. Do not create cloud resources, deploy, or put secrets while executing these tasks — every step needing a real Cloudflare account or the real domain is collected in "Deferred: needs your Cloudflare account" at the end of this plan.

---

## Task 1: Monorepo scaffold — move the frontend into `apps/web`

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json` (new root manifest)
- Modify (move): `components.json`, `index.html`, `package.json` (old, frontend one), `public/`, `src/`, `tsconfig.json`, `vite.config.ts` → all into `apps/web/`
- Modify: `apps/web/package.json` (rename), `.gitignore`
- Delete: root `package-lock.json`

**Interfaces:**
- Produces: `apps/web` — the existing frontend, unchanged in behavior, now living one level deeper. Later tasks that touch the frontend (Task 9, 10) work inside `apps/web/src/`.

- [ ] **Step 1: Move the frontend files**

```bash
mkdir -p apps/web
git mv components.json apps/web/components.json
git mv index.html apps/web/index.html
git mv package.json apps/web/package.json
git mv public apps/web/public
git mv src apps/web/src
git mv tsconfig.json apps/web/tsconfig.json
git mv vite.config.ts apps/web/vite.config.ts
git rm package-lock.json
rm -rf apps/web/node_modules
```

- [ ] **Step 2: Rename the moved package**

In `apps/web/package.json`, change:

```json
  "name": "bud-clone",
```

to:

```json
  "name": "@benchy/web",
```

- [ ] **Step 3: Create the pnpm workspace file**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 4: Create the root package.json**

Create `package.json`:

```json
{
  "name": "benchy-agent",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@10.16.0",
  "scripts": {
    "dev:web": "pnpm --filter @benchy/web dev",
    "dev:api": "pnpm --filter @benchy/api dev",
    "invite": "pnpm --filter @benchy/api invite"
  }
}
```

- [ ] **Step 5: Update .gitignore for the workspace**

Add these lines to `.gitignore` (keep the existing lines):

```
.wrangler/
.dev.vars
```

- [ ] **Step 6: Install and verify**

```bash
pnpm install
pnpm --filter @benchy/web dev
```

In another terminal, confirm it still serves:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:21707/
```

Expected: `200`. Stop the dev server after confirming.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Convert to pnpm monorepo, move frontend into apps/web"
```

---

## Task 2: Shared Drizzle schema (`packages/db`)

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/src/index.ts`

**Interfaces:**
- Produces: `schema.user` (with `orgId`), `schema.session`, `schema.account`, `schema.verification` (better-auth's tables, hand-defined to match its documented core schema), `schema.orgs`, `schema.invites`. Exported as a single `schema` namespace from `@benchy/db`. Task 4 imports this for the Drizzle adapter; Task 6 and Task 8 query `orgs`/`invites` directly.

- [ ] **Step 1: Create the package manifest**

Create `packages/db/package.json`:

```json
{
  "name": "@benchy/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "generate": "drizzle-kit generate"
  },
  "dependencies": {
    "drizzle-orm": "^0.45.2"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.10"
  }
}
```

- [ ] **Step 2: Create the TypeScript config**

Create `packages/db/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write the schema**

Create `packages/db/src/schema.ts`. The `user`/`session`/`account`/`verification` tables match better-auth's documented core schema field-for-field (column names kept identical to the JS field names, so no `fields: {...}` remapping is needed in the adapter config). `orgs` and `invites` are app-owned.

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  orgId: text("orgId")
    .notNull()
    .references(() => orgs.id),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  status: text("status", { enum: ["pending", "accepted", "expired"] })
    .notNull()
    .default("pending"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
});

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  // Defaulted, not just NOT NULL: magic-link signup has no name to supply.
  name: text("name").notNull().default(""),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  orgId: text("orgId").references(() => orgs.id),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", {
    mode: "timestamp",
  }),
  scope: text("scope"),
  idToken: text("idToken"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});
```

- [ ] **Step 4: Export the schema**

Create `packages/db/src/index.ts`:

```ts
export * as schema from "./schema";
```

- [ ] **Step 5: Create the drizzle-kit config**

Create `packages/db/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
```

- [ ] **Step 6: Install and generate the migration**

```bash
pnpm install
pnpm --filter @benchy/db generate
```

Expected: a new file under `packages/db/migrations/` (e.g. `0000_<name>.sql`) plus a `packages/db/migrations/meta/` folder. Open the generated `.sql` file and confirm it contains six `CREATE TABLE` statements: `orgs`, `invites`, `user`, `session`, `account`, `verification`, with the columns from Step 3.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "Add shared Drizzle schema for identity, orgs, and invites"
```

---

## Task 3: `apps/api` Worker skeleton + D1 wiring

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/wrangler.jsonc`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/index.ts`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/test/apply-migrations.ts`
- Create: `apps/api/test/env.d.ts`
- Create: `apps/api/test/health.test.ts`

**Interfaces:**
- Produces: the Hono `app` default export from `apps/api/src/index.ts`, which Task 4 extends with the auth route. The D1 binding is `env.DB` everywhere from here on.

- [ ] **Step 1: (Deferred) Create the real D1 database**

Skip this step for now — it is listed here so the sequence reads correctly, but it needs a Cloudflare account and belongs to the deferred handoff at the end of the plan. Step 3 uses a placeholder `database_id`; local development and the entire test suite run against Miniflare's simulated D1, which ignores it.

When the account exists, this is the command, and its output UUID replaces the placeholder in `wrangler.jsonc`:

```bash
npx wrangler login
npx wrangler d1 create benchy-db
```

- [ ] **Step 2: Install dependencies**

```bash
mkdir -p apps/api/src apps/api/test
cd apps/api
pnpm init
pnpm add hono@^4.13.8 better-auth@^1.7.5 @better-auth/drizzle-adapter@^1.7.5 drizzle-orm@^0.45.2 @benchy/db@workspace:*
pnpm add -D wrangler@^4.134.0 @cloudflare/vitest-plugin@^1.1.12 @cloudflare/workers-types@^5.20260917.1 vitest@^5.0.1 typescript@~5.9.2 tsx@^4.23.13
cd ../..
```

Then set `apps/api/package.json`'s `"name"` field to `"@benchy/api"` and `"private": true`, and add these scripts:

```json
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "types": "wrangler types",
    "db:migrate:local": "wrangler d1 migrations apply benchy-db --local",
    "db:migrate:remote": "wrangler d1 migrations apply benchy-db --remote"
  }
```

- [ ] **Step 3: Create the wrangler config**

Create `apps/api/wrangler.jsonc` (replace `00000000-0000-0000-0000-000000000000` with the UUID from Step 1, and `benchy.example` with your real domain):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "benchy-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-17",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "benchy-db",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "../../packages/db/migrations"
    }
  ],
  "send_email": [{ "name": "EMAIL" }],
  "vars": {
    "BETTER_AUTH_URL": "https://api.benchy.example"
  }
}
```

- [ ] **Step 4: Apply the migration locally and generate types**

```bash
cd apps/api
pnpm db:migrate:local
pnpm types
cd ../..
```

`pnpm types` generates `apps/api/src/worker-configuration.d.ts` (or `env.d.ts`, wrangler names it based on your wrangler version's default — check the file it prints) declaring `Env` with `DB: D1Database` and `EMAIL: SendEmail` from your `wrangler.jsonc`. Do not hand-edit this file; re-run `pnpm types` whenever `wrangler.jsonc` bindings change.

- [ ] **Step 5: Create the TypeScript config**

Create `apps/api/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2021",
    "lib": ["es2021"],
    "module": "es2022",
    "moduleResolution": "bundler",
    "types": ["./worker-configuration.d.ts"],
    "resolveJsonModule": true,
    "noEmit": true,
    "isolatedModules": true,
    "strict": true,
    "skipLibCheck": true
  },
  "exclude": ["test"]
}
```

If Step 4 generated a differently-named types file, update the `types` array to match its actual filename.

- [ ] **Step 6: Write the Worker entry point**

Create `apps/api/src/index.ts`:

```ts
import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

export default app;
```

- [ ] **Step 7: Set up the test infrastructure**

Create `apps/api/vitest.config.ts`:

```ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, defineProject, mergeConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrationsPath = path.join(
    import.meta.dirname,
    "..",
    "..",
    "packages",
    "db",
    "migrations",
  );
  const migrations = await readD1Migrations(migrationsPath);

  return mergeConfig(
    {},
    defineProject({
      plugins: [
        cloudflareTest({
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },
          },
        }),
      ],
      test: {
        setupFiles: ["./test/apply-migrations.ts"],
      },
    }),
  );
});
```

Create `apps/api/test/env.d.ts`:

```ts
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
```

Create `apps/api/test/apply-migrations.ts`:

```ts
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 8: Write the health check test**

Create `apps/api/test/health.test.ts`:

```ts
import { exports } from "cloudflare:workers";
import { it } from "vitest";

it("returns ok from /health", async ({ expect }) => {
  const response = await exports.default.fetch(
    "https://example.com/health",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
```

- [ ] **Step 9: Run the test**

```bash
cd apps/api && pnpm test && cd ../..
```

Expected: 1 test passes.

- [ ] **Step 10: Commit**

```bash
git add apps/api
git commit -m "Scaffold apps/api Worker with D1 binding and test infra"
```

---

## Task 4: Mount better-auth (core config, no sign-in methods yet)

**Files:**
- Create: `apps/api/src/auth.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/wrangler.jsonc` (add `BETTER_AUTH_SECRET` note)
- Create: `apps/api/.dev.vars` (local secrets, gitignored)
- Create: `apps/api/test/session.test.ts`

**Interfaces:**
- Consumes: `schema` from `@benchy/db` (Task 2), `Env.DB` (Task 3).
- Produces: `auth` (the better-auth instance) from `apps/api/src/auth.ts`, imported by Task 5 (to add plugins/hooks) and by any future protected route.

- [ ] **Step 1: Generate a local secret and set up `.dev.vars`**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Create `apps/api/.dev.vars` (this file is gitignored — never commit it):

```
BETTER_AUTH_SECRET=<paste the generated hex string here>
```

Then regenerate types, so the generated `Env` includes `BETTER_AUTH_SECRET` (wrangler reads `.dev.vars` when generating types):

```bash
pnpm --filter @benchy/api types
```

For production, set the real secret once you deploy:

```bash
cd apps/api && npx wrangler secret put BETTER_AUTH_SECRET && cd ../..
```

- [ ] **Step 2: Write the auth config**

Create `apps/api/src/auth.ts` (replace `benchy.example` with your real domain in both places):

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { schema } from "@benchy/db";

const db = drizzle(env.DB, { schema });

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema,
  }),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [
    "https://app.benchy.example",
    "https://api.benchy.example",
    "http://localhost:21707",
  ],
  advanced: {
    crossSubDomainCookies: {
      enabled: true,
      domain: "benchy.example",
    },
  },
  user: {
    additionalFields: {
      orgId: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },
});
```

`input: false` on `orgId` stops it from being settable via the public update-user API — only our own server-side code (Task 6's hook) may set it.

- [ ] **Step 3: Mount the auth handler with CORS**

Replace `apps/api/src/index.ts`:

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";

const app = new Hono<{ Bindings: Env }>();

app.use(
  "/api/auth/*",
  cors({
    origin: ["https://app.benchy.example", "http://localhost:21707"],
    credentials: true,
  }),
);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/health", (c) => c.json({ ok: true }));

export default app;
```

- [ ] **Step 4: Write a session smoke test**

Create `apps/api/test/session.test.ts`:

```ts
import { exports } from "cloudflare:workers";
import { it } from "vitest";

it("returns an empty session when signed out", async ({ expect }) => {
  const response = await exports.default.fetch(
    "https://example.com/api/auth/get-session",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toBeNull();
});
```

- [ ] **Step 5: Run the test**

```bash
cd apps/api && pnpm test && cd ../..
```

Expected: 2 tests pass (this one plus Task 3's health check). If `get-session` isn't the exact route name in your installed better-auth version, run `pnpm --filter @benchy/api dev` and open `http://localhost:8787/api/auth/reference` (better-auth's built-in OpenAPI reference UI) to find the exact path, then update the test.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "Mount better-auth with Drizzle/D1 adapter and cross-subdomain cookies"
```

---

## Task 5: Magic link + Google OAuth sign-in

**Files:**
- Modify: `apps/api/src/auth.ts`
- Modify: `apps/api/.dev.vars`
- Create: `apps/api/test/magic-link.test.ts`

**Interfaces:**
- Consumes: `env.EMAIL` (the `send_email` binding from Task 3's `wrangler.jsonc`).
- Produces: `auth` now signs in via `signIn.magicLink` and `signIn.social({provider: "google"})`. Task 6 adds the invite gate on top of the account-creation path both of these share.

- [ ] **Step 1: (Deferred) Onboard the sending domain and create the Google OAuth app**

Skip both for now — they need a Cloudflare account and a Google Cloud project, and are collected in the deferred handoff at the end of the plan. Recorded here so the sequence reads correctly:

```bash
npx wrangler email sending enable benchy.example
npx wrangler email sending dns get benchy.example   # add the printed SPF/DKIM records at your DNS provider
```

In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), an OAuth 2.0 Client ID (type: Web application) with authorized redirect URI `https://api.benchy.example/api/auth/callback/google`.

- [ ] **Step 2: Add placeholder Google credentials locally**

better-auth validates that a configured social provider has non-empty credentials, so local dev and the test suite need *some* value. Append to `apps/api/.dev.vars` (git-ignored):

```
GOOGLE_CLIENT_ID=local-dev-placeholder
GOOGLE_CLIENT_SECRET=local-dev-placeholder
```

These are deliberately fake. Google sign-in will not work locally — that is expected and is covered by the deferred handoff. Nothing in the automated tests exercises a real OAuth round trip.

Then regenerate types so `Env` includes them:

```bash
pnpm --filter @benchy/api types
```

- [ ] **Step 3: Add the plugins and social provider**

In `apps/api/src/auth.ts`, add the magic link plugin (sending through the `EMAIL` binding) and Google as a social provider. Add these imports at the top:

```ts
import { magicLink } from "better-auth/plugins";
```

Add these two top-level keys to the `betterAuth({...})` call, alongside `database`, `baseURL`, etc.:

```ts
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await env.EMAIL.send({
          to: email,
          from: { email: "auth@benchy.example", name: "Benchy" },
          subject: "Sign in to Benchy",
          text: `Click to sign in: ${url}\n\nThis link expires in 5 minutes.`,
          html: `<p>Click to sign in: <a href="${url}">${url}</a></p><p>This link expires in 5 minutes.</p>`,
        });
      },
    }),
  ],
```

- [ ] **Step 4: Verify it typechecks and boots**

There is deliberately no automated test in this task. Both sign-in paths reach outward — magic link calls `env.EMAIL.send`, Google needs a real OAuth redirect — and the invite gate that makes either meaningful doesn't exist until Task 6, which is where the sign-in behaviour gets its tests.

```bash
cd apps/api
pnpm exec tsc --noEmit
pnpm dev
```

With `wrangler dev` running, in another terminal:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/api/auth/get-session
```

Expected: `200`, and no startup errors in the `wrangler dev` output (a missing `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in `.dev.vars` shows up here as a better-auth config error). Also confirm the existing tests still pass:

```bash
pnpm test
```

Expected: the 2 tests from Tasks 3 and 4 still pass. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "Add magic link and Google OAuth sign-in"
```

---

## Task 6: Invite gate

This is the core business rule from the spec: an account may only be created for an email that has a pending, non-expired invite. It is enforced in two places, both calling the same module:

1. **At magic-link request time** — so an uninvited person gets an immediate error on the login form instead of an email, and so the Worker can't be used to mail arbitrary addresses.
2. **At user-creation time** — the authoritative gate. This is the one that also covers Google OAuth, where no magic link is ever requested.

Returning users must keep working: once someone signs up, their invite is `accepted`, so they no longer have a pending invite. The request-time gate therefore passes anyone who already has a user row.

**Files:**
- Create: `apps/api/src/invite-gate.ts`
- Create: `apps/api/test/invite-gate.test.ts`
- Create: `apps/api/test/magic-link-gate.test.ts`
- Modify: `apps/api/src/auth.ts`

**Interfaces:**
- Consumes: `schema.invites`, `schema.user`, `schema.orgs` from `@benchy/db`; the `db` Drizzle instance created in `auth.ts` (Task 4).
- Produces: `findPendingInvite(db, email)`, `requireInviteForSignup(db, email)`, `requireInviteOrExistingUser(db, email)`, `markInviteAccepted(db, inviteId)` from `apps/api/src/invite-gate.ts`. After this task, a new user's `orgId` is set from their invite and that invite becomes `accepted`.

- [ ] **Step 1: Write the failing tests**

The business rules are tested directly against the gate module rather than through a sign-in flow. Magic link only creates a user when its emailed link is *clicked*, and Google OAuth needs a real redirect — neither is reachable synchronously from a test, so driving the rules through them would test plumbing instead of rules. Step 6 adds one integration test that proves the module is actually wired in.

Create `apps/api/test/invite-gate.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { beforeEach, it } from "vitest";
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && pnpm test && cd ../..
```

Expected: every test in `invite-gate.test.ts` fails with "Cannot find module '../src/invite-gate'".

- [ ] **Step 3: Implement the gate module**

Create `apps/api/src/invite-gate.ts`:

```ts
import { APIError } from "better-auth/api";
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "@benchy/db";

type Db = DrizzleD1Database<typeof schema>;

const NO_INVITE_MESSAGE =
  "This email has no pending invite. Ask your university admin for one.";

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
    .orderBy(desc(schema.invites.createdAt))
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
    throw new APIError("FORBIDDEN", { message: NO_INVITE_MESSAGE });
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
  throw new APIError("FORBIDDEN", { message: NO_INVITE_MESSAGE });
}

export async function markInviteAccepted(db: Db, inviteId: string) {
  await db
    .update(schema.invites)
    .set({ status: "accepted" })
    .where(eq(schema.invites.id, inviteId));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api && pnpm test && cd ../..
```

Expected: all `invite-gate.test.ts` tests pass.

- [ ] **Step 5: Wire the gate into better-auth**

In `apps/api/src/auth.ts`, add the import:

```ts
import {
  findPendingInvite,
  markInviteAccepted,
  requireInviteForSignup,
  requireInviteOrExistingUser,
} from "./invite-gate";
```

Add a `databaseHooks` key to the `betterAuth({...})` call:

```ts
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const invite = await requireInviteForSignup(db, user.email);
          return {
            data: {
              ...user,
              email: user.email.toLowerCase(),
              orgId: invite.orgId,
            },
          };
        },
        after: async (createdUser) => {
          const invite = await findPendingInvite(db, createdUser.email);
          if (invite) await markInviteAccepted(db, invite.id);
        },
      },
    },
  },
```

Then add the request-time check as the first line of the `sendMagicLink` callback written in Task 5, so no email is ever sent to an uninvited address:

```ts
      sendMagicLink: async ({ email, url }) => {
        await requireInviteOrExistingUser(db, email);
        await env.EMAIL.send({
```

- [ ] **Step 6: Write the wiring test**

Create `apps/api/test/magic-link-gate.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { beforeEach, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import { auth } from "../src/auth";

const db = drizzle(env.DB, { schema });

beforeEach(async () => {
  await db.delete(schema.invites);
  await db.delete(schema.user);
  await db.delete(schema.orgs);
});

it("refuses to send a magic link to an uninvited address", async ({
  expect,
}) => {
  await expect(
    auth.api.signInMagicLink({ body: { email: "stranger@example.com" } }),
  ).rejects.toThrow();
});
```

This covers only the rejection path on purpose: the happy path would call `env.EMAIL.send`, whose behaviour under Miniflare is not something worth hanging a test on. The happy path is covered by the final manual end-to-end check.

- [ ] **Step 7: Run the tests**

```bash
cd apps/api && pnpm test && cd ../..
```

Expected: all tests pass.

Two things that can legitimately differ here, both with a defined fallback:
- If `auth.api.signInMagicLink` doesn't exist under that name, run `pnpm --filter @benchy/api dev` and open `http://localhost:8787/api/auth/reference` to find the generated method name (better-auth mirrors each REST route as a camelCase method on `auth.api`), then update the test.
- If it resolves instead of rejecting, better-auth is swallowing errors thrown from `sendMagicLink`. In that case delete this test file and rely on the `user.create.before` gate, which is still authoritative (no user is ever created) — and tell the Task 9 implementer, because the login form will then show "check your email" to uninvited people rather than an inline error.

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "Gate signup and magic-link requests on a pending invite"
```

---

## Task 7: Invite CLI — pure helpers

**Files:**
- Create: `apps/api/scripts/invite-lib.ts`
- Create: `apps/api/scripts/invite-lib.test.ts`

**Interfaces:**
- Produces: `slugify(name: string): string`, `generateInviteToken(): string`, `generateId(prefix: string): string`, `escapeSqlString(value: string): string` — pure functions with no I/O, consumed by Task 8's `invite.ts`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/scripts/invite-lib.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  slugify,
  generateInviteToken,
  generateId,
  escapeSqlString,
} from "./invite-lib";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Stanford University")).toBe("stanford-university");
  });

  it("strips punctuation", () => {
    expect(slugify("St. Mary's College")).toBe("st-marys-college");
  });

  it("collapses repeated separators", () => {
    expect(slugify("MIT   (Cambridge)")).toBe("mit-cambridge");
  });
});

describe("generateInviteToken", () => {
  it("returns a 64-character hex string", () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different value each call", () => {
    expect(generateInviteToken()).not.toBe(generateInviteToken());
  });
});

describe("generateId", () => {
  it("prefixes the id", () => {
    expect(generateId("org")).toMatch(/^org_[0-9a-f]{16}$/);
  });
});

describe("escapeSqlString", () => {
  it("doubles single quotes", () => {
    expect(escapeSqlString("St. Mary's College")).toBe(
      "St. Mary''s College",
    );
  });

  it("leaves strings without quotes unchanged", () => {
    expect(escapeSqlString("Stanford")).toBe("Stanford");
  });
});
```

This file runs under plain Node, not the Workers pool — it needs its own `vitest` invocation, separate from `apps/api/test/`.

- [ ] **Step 2: Add a config and script for node-side tests**

Create `apps/api/vitest.node.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
  },
});
```

Add to `apps/api/package.json` scripts:

```json
    "test:scripts": "vitest run --config vitest.node.config.ts"
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/api && pnpm test:scripts && cd ../..
```

Expected: fails with "Cannot find module './invite-lib'".

- [ ] **Step 4: Implement the helpers**

Create `apps/api/scripts/invite-lib.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/api && pnpm test:scripts && cd ../..
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "Add pure helpers for the invite CLI script"
```

---

## Task 8: Invite CLI — the admin script

**Files:**
- Create: `apps/api/scripts/invite.ts`

**Interfaces:**
- Consumes: `slugify`, `generateInviteToken`, `generateId`, `escapeSqlString` from Task 7.
- Produces: the `pnpm invite --org "<name>" --email <email>` command referenced in the spec's invite flow. Writes to the real D1 database and sends a real email — there is no automated test for this task; verification is manual, against your actual Cloudflare account.

- [ ] **Step 1: Write the script**

Create `apps/api/scripts/invite.ts`:

```ts
import { execFileSync } from "node:child_process";
import {
  slugify,
  generateInviteToken,
  generateId,
  escapeSqlString,
} from "./invite-lib";

const DB_NAME = "benchy-db";
const INVITE_TTL_DAYS = 7;
const FROM_ADDRESS = "invites@benchy.example";
const APP_BASE_URL = "https://app.benchy.example";

function parseArgs(argv: string[]): { org: string; email: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (!flag || value === undefined) {
      throw new Error("Usage: pnpm invite --org \"<name>\" --email <email>");
    }
    args[flag] = value;
  }
  if (!args.org || !args.email) {
    throw new Error("Usage: pnpm invite --org \"<name>\" --email <email>");
  }
  return { org: args.org, email: args.email.toLowerCase() };
}

function d1Execute(sql: string): unknown {
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB_NAME, "--remote", "--json", "--command", sql],
    // stdin/stderr inherited so that a wrangler confirmation prompt is visible
    // and answerable instead of hanging on a captured pipe.
    { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"] },
  );
  return JSON.parse(output);
}

function findOrgIdBySlug(slug: string): string | null {
  const result = d1Execute(
    `SELECT id FROM orgs WHERE slug = '${escapeSqlString(slug)}'`,
  ) as Array<{ results: Array<{ id: string }> }>;
  const row = result[0]?.results?.[0];
  return row ? row.id : null;
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

  let orgId = findOrgIdBySlug(slug);
  if (!orgId) {
    orgId = createOrg(org, slug);
    console.log(`Created org "${org}" (${slug})`);
  } else {
    console.log(`Using existing org "${org}" (${slug})`);
  }

  const token = createInvite(orgId, email);
  sendInviteEmail(email, org, token);
  console.log(`Invite sent to ${email}. Token (for manual testing): ${token}`);
}

main();
```

- [ ] **Step 2: Wire the script into package.json**

Add to `apps/api/package.json` scripts (this replaces the `tsx`-based placeholder from the root `package.json`'s `invite` script, which forwards to this):

```json
    "invite": "tsx scripts/invite.ts"
```

- [ ] **Step 3: (Deferred) Manual verification**

This script writes to the *remote* D1 database and sends a real email, so it cannot be exercised now — it is item 8 of the deferred handoff at the end of this plan. For this task, verification is limited to: `pnpm --filter @benchy/api exec tsc --noEmit` passes, and `pnpm --filter @benchy/api invite` with no arguments prints the usage error rather than crashing.

When the account exists, run:

```bash
pnpm invite --org "Test University" --email you+test1@benchy.example
```

Confirm: the command prints "Created org", then "Invite sent", and you receive the email at the address you used. Then inspect the row directly:

```bash
npx wrangler d1 execute benchy-db --remote --command "SELECT * FROM invites"
```

If the `--json` output shape from `wrangler d1 execute` in Step 1 of `d1Execute` doesn't match `Array<{results: [...]}>` on your installed wrangler version, adjust `findOrgIdBySlug`'s parsing to match what you actually see (print `output` before parsing to inspect it).

Run it a second time with the same org name to confirm the "Using existing org" path also works, and that it doesn't create a duplicate `orgs` row.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "Add admin invite CLI script"
```

---

## Task 9: Frontend auth client + login page

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/lib/auth-client.ts`
- Create: `apps/web/src/pages/login.tsx`
- Create: `apps/web/.env` (local dev, gitignored via existing `*.env*`... see note below)

**Interfaces:**
- Produces: `authClient`, `useSession`, `signIn` exported from `apps/web/src/lib/auth-client.ts`. `Login` component default-exported from `apps/web/src/pages/login.tsx`. Task 10 imports both.

- [ ] **Step 1: Add better-auth to the frontend**

```bash
pnpm --filter @benchy/web add better-auth@^1.7.5
```

- [ ] **Step 2: Add the API base URL env var**

Create `apps/web/.env` (replace `benchy.example`; this is a local-dev value — production sets the same var through your Cloudflare Pages project settings):

```
VITE_API_URL=https://api.benchy.example
```

Confirm it's git-ignored: `.gitignore` at the repo root doesn't currently list `.env`, so add this line to it:

```
.env
```

- [ ] **Step 3: Create the auth client**

Create `apps/web/src/lib/auth-client.ts`:

```ts
import { createAuthClient } from "better-auth/client";
import { magicLinkClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_URL,
  plugins: [magicLinkClient()],
});

export const { useSession, signIn, signOut } = authClient;
```

- [ ] **Step 4: Build the login page**

Create `apps/web/src/pages/login.tsx`:

```tsx
import { useState } from "react";
import { signIn } from "@/lib/auth-client";

export default function Login() {
  // Read straight from the URL rather than a router hook: this component is
  // rendered by AuthGate outside any <Route>, so there are no route params
  // to read, and the invite link can land on any path.
  const [email, setEmail] = useState(
    () => new URLSearchParams(window.location.search).get("email") ?? "",
  );
  const [status, setStatus] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMessage("");
    const { error } = await signIn.magicLink({
      email,
      callbackURL: "/",
    });
    if (error) {
      setStatus("error");
      setErrorMessage(
        error.message ??
          "This email has no pending invite. Ask your university admin for one.",
      );
      return;
    }
    setStatus("sent");
  }

  async function handleGoogle() {
    await signIn.social({ provider: "google", callbackURL: "/" });
  }

  if (status === "sent") {
    return (
      <div className="mx-auto mt-24 max-w-sm text-center">
        <h1 className="text-lg font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We sent a sign-in link to {email}.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-sm">
      <h1 className="text-lg font-semibold">Sign in to Benchy</h1>
      <form onSubmit={handleMagicLink} className="mt-4 space-y-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@university.edu"
          className="w-full rounded border px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={status === "sending"}
          className="w-full rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          {status === "sending" ? "Sending..." : "Send magic link"}
        </button>
      </form>
      {status === "error" && (
        <p className="mt-3 text-sm text-destructive">{errorMessage}</p>
      )}
      <div className="mt-4 border-t pt-4">
        <button
          onClick={handleGoogle}
          className="w-full rounded border px-3 py-2 text-sm"
        >
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Verify it typechecks**

```bash
pnpm --filter @benchy/web exec tsc -p tsconfig.json --noEmit
```

Expected: no errors. There is nothing to look at in a browser yet — nothing renders `Login` until Task 10 mounts `AuthGate`, and this component is deliberately not wired to a `/login` route (see Task 10).

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "Add better-auth client and login page"
```

---

## Task 10: Route guard and invite-acceptance wiring

**Files:**
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/components/auth-gate.tsx`

**Interfaces:**
- Consumes: `useSession` from Task 9's `auth-client.ts`, `Login` from Task 9's `login.tsx`.
- Produces: unauthenticated visitors see `Login` instead of the app; authenticated-but-orgless visitors see a holding message; everyone else sees the existing `Router`.

- [ ] **Step 1: Write the auth gate component**

Create `apps/web/src/components/auth-gate.tsx`:

```tsx
import type { ReactNode } from "react";
import { useSession } from "@/lib/auth-client";
import Login from "@/pages/login";

export function AuthGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return null;
  }

  if (!session) {
    return <Login />;
  }

  // orgId is a better-auth additionalField; the client's inferred user type
  // doesn't know about it without wiring the server type across packages.
  const { orgId } = session.user as { orgId?: string | null };

  if (!orgId) {
    return (
      <div className="mx-auto mt-24 max-w-sm text-center">
        <h1 className="text-lg font-semibold">Almost there</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account isn't linked to an organization yet. Ask your
          university admin to send you an invite for this email address.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
```

- [ ] **Step 2: Wire it into App.tsx**

In `apps/web/src/App.tsx`, add the import:

```tsx
import { AuthGate } from "@/components/auth-gate";
```

Wrap the existing `<Router />` (leave everything else in `App` unchanged):

```tsx
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthGate>
            <Router />
          </AuthGate>
        </WouterRouter>
```

- [ ] **Step 3: Verify in a browser**

```bash
pnpm --filter @benchy/web exec tsc -p tsconfig.json --noEmit
pnpm --filter @benchy/web dev
```

Open `http://localhost:21707/`. Confirm you see the login page rather than the benchy UI, since no session cookie exists yet. Then open `http://localhost:21707/accept-invite?email=someone@example.edu` and confirm the email field is prefilled — that path has no route of its own on purpose: `AuthGate` renders `Login` for *any* path while signed out, and `Login` reads the query string directly, so the invite link works without adding a route.

Note the session lookup will fail in the console against a not-yet-deployed API (`VITE_API_URL`); the signed-out rendering is still correct and is what this step verifies. End-to-end sign-in is the final manual check below, after `wrangler deploy`.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "Add auth route guard to the frontend"
```

---

## Deferred: needs your Cloudflare account

Nothing below runs during Tasks 1–10. Each item needs either a real Cloudflare account, the real domain, or a Google Cloud project. Work through them in order when you have all three.

1. **Pick the domain** and find-and-replace `benchy.example` across the repo with it (17 occurrences at plan-writing time; `grep -rn "benchy.example" apps packages` finds the current set).
2. **Create the database** and paste its UUID over the placeholder `database_id` in `apps/api/wrangler.jsonc`:
   ```bash
   npx wrangler login
   npx wrangler d1 create benchy-db
   ```
3. **Apply migrations remotely:** `pnpm --filter @benchy/api db:migrate:remote`
4. **Onboard the sending domain** and add the printed SPF/DKIM records at your DNS provider:
   ```bash
   npx wrangler email sending enable <your-domain>
   npx wrangler email sending dns get <your-domain>
   ```
5. **Create the Google OAuth client** (Web application) with redirect URI `https://api.<your-domain>/api/auth/callback/google`.
6. **Set the real production secrets** (the `.dev.vars` values are local placeholders and must not be reused):
   ```bash
   cd apps/api
   npx wrangler secret put BETTER_AUTH_SECRET     # a fresh 32-byte hex string
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
7. **Deploy:** `pnpm --filter @benchy/api deploy`, and deploy `apps/web` to Cloudflare Pages with `VITE_API_URL=https://api.<your-domain>`.
8. **Run the invite script for real** (this is also the first genuine exercise of Task 8's `--remote` D1 writes and email send — check its `--json` parsing against real wrangler output here):
   ```bash
   pnpm invite --org "Your Test Org" --email <your own email>
   ```

Then the end-to-end check:

1. Open the link from the invite email.
2. Confirm you land signed in, on the real app — not the "almost there" holding page.
3. Try signing in with a second, uninvited email address and confirm you get the invite-required error instead of getting in.
4. Sign out and sign in again with the first address, confirming a returning user (whose invite is now `accepted`) can still get back in.
