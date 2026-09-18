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
- Replace `<your-domain>` in every file below with the real domain once you have it wired into Cloudflare. Do this as a single find-and-replace pass after Task 3; every occurrence is marked.

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
  name: text("name").notNull(),
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

- [ ] **Step 1: Create a D1 database**

```bash
npx wrangler login   # if not already logged in
npx wrangler d1 create benchy-db
```

Copy the `database_id` (a UUID) from the output — you'll need it in Step 3.

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

Create `apps/api/wrangler.jsonc` (replace `<D1_DATABASE_ID>` with the UUID from Step 1, and `<your-domain>` with your real domain):

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
      "database_id": "<D1_DATABASE_ID>",
      "migrations_dir": "../../packages/db/migrations"
    }
  ],
  "send_email": [{ "name": "EMAIL" }],
  "vars": {
    "BETTER_AUTH_URL": "https://api.<your-domain>"
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

For production, set the real secret once you deploy:

```bash
cd apps/api && npx wrangler secret put BETTER_AUTH_SECRET && cd ../..
```

- [ ] **Step 2: Write the auth config**

Create `apps/api/src/auth.ts` (replace `<your-domain>` with your real domain in both places):

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
    "https://app.<your-domain>",
    "https://api.<your-domain>",
    "http://localhost:5173",
  ],
  advanced: {
    crossSubDomainCookies: {
      enabled: true,
      domain: "<your-domain>",
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
    origin: ["https://app.<your-domain>", "http://localhost:5173"],
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

- [ ] **Step 1: Onboard your domain for sending, and create a Google OAuth app**

```bash
npx wrangler email sending enable <your-domain>
npx wrangler email sending dns get <your-domain>   # add the printed SPF/DKIM records at your DNS provider
```

In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an OAuth 2.0 Client ID (type: Web application) with authorized redirect URI `https://api.<your-domain>/api/auth/callback/google`. Copy the client ID and secret.

- [ ] **Step 2: Add the Google credentials locally**

Append to `apps/api/.dev.vars`:

```
GOOGLE_CLIENT_ID=<paste client id>
GOOGLE_CLIENT_SECRET=<paste client secret>
```

For production:

```bash
cd apps/api
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
cd ../..
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
          from: { email: "auth@<your-domain>", name: "Benchy" },
          subject: "Sign in to Benchy",
          text: `Click to sign in: ${url}\n\nThis link expires in 5 minutes.`,
          html: `<p>Click to sign in: <a href="${url}">${url}</a></p><p>This link expires in 5 minutes.</p>`,
        });
      },
    }),
  ],
```

- [ ] **Step 4: Write a magic-link sign-in test**

This test captures the magic-link URL by asserting on the outbound email content rather than actually sending it — `env.EMAIL.send` still runs against the real binding in tests, so use a throwaway address you don't need delivered.

Create `apps/api/test/magic-link.test.ts`:

```ts
import { exports } from "cloudflare:workers";
import { it } from "vitest";
import { auth } from "../src/auth";

it("issues a magic link for sign-in", async ({ expect }) => {
  const result = await auth.api.signInMagicLink({
    body: { email: "researcher@example.com" },
  });
  expect(result.status).toBe(true);
});
```

If `auth.api.signInMagicLink` doesn't exist under that exact name in your installed version, run `pnpm --filter @benchy/api dev` and check `http://localhost:8787/api/auth/reference` for the generated method name (better-auth mirrors every REST route as a camelCase method on `auth.api`) and use that instead.

- [ ] **Step 5: Run the test**

```bash
cd apps/api && pnpm test && cd ../..
```

Expected: 3 tests pass. This test will currently send a real (harmless, undeliverable) email attempt through the `EMAIL` binding in Miniflare — that's expected and fine in tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "Add magic link and Google OAuth sign-in"
```

---

## Task 6: Invite-gate database hook

This is the core business rule from the spec: account creation is blocked unless a pending, non-expired invite exists for that email.

**Files:**
- Modify: `apps/api/src/auth.ts`
- Create: `apps/api/test/invite-gate.test.ts`

**Interfaces:**
- Consumes: `schema.invites`, `schema.orgs` from `@benchy/db`; the `db` Drizzle instance already created in `auth.ts` (Task 4).
- Produces: every new user created via magic link or Google gets `orgId` set from their invite, and the invite's `status` becomes `"accepted"`. An email with no matching invite gets `APIError("FORBIDDEN")` instead of an account.

- [ ] **Step 1: Write the failing tests**

This drives account creation through `signUpEmail` (email/password) rather than magic link. Magic link only creates a user when its emailed link is *clicked* — there is no way to reach the create-user path synchronously from a test without first intercepting a token out of a sent email. `signUpEmail` reaches the exact same `databaseHooks.user.create.before`/`after` hook synchronously, which is what this task is actually testing. Password sign-up itself is never exposed to end users (no password UI exists in the frontend, Task 9) — this is a test-only entry point into the shared hook, and the hook governs magic link and Google OAuth identically in production.

Create `apps/api/test/invite-gate.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { it, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { auth } from "../src/auth";

const db = drizzle(env.DB, { schema });

beforeEach(async () => {
  await db.delete(schema.invites);
  await db.delete(schema.user);
  await db.delete(schema.orgs);
});

it("rejects account creation with no matching pending invite", async ({
  expect,
}) => {
  await expect(
    auth.api.signUpEmail({
      body: {
        email: "uninvited@example.com",
        name: "No Invite",
        password: "throwaway-not-used-by-magic-link",
      },
    }),
  ).rejects.toThrow();

  const rows = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, "uninvited@example.com"));
  expect(rows).toHaveLength(0);
});

it("accepts account creation, sets orgId, and marks the invite accepted", async ({
  expect,
}) => {
  const now = new Date();
  await db.insert(schema.orgs).values({
    id: "org_stanford",
    name: "Stanford",
    slug: "stanford",
    createdAt: now,
  });
  await db.insert(schema.invites).values({
    id: "invite_1",
    orgId: "org_stanford",
    email: "invited@example.com",
    token: "test-token",
    status: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
  });

  await auth.api.signUpEmail({
    body: {
      email: "invited@example.com",
      name: "Invited Researcher",
      password: "throwaway-not-used-by-magic-link",
    },
  });

  const [createdUser] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, "invited@example.com"));
  expect(createdUser?.orgId).toBe("org_stanford");

  const [acceptedInvite] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.id, "invite_1"));
  expect(acceptedInvite?.status).toBe("accepted");
});

it("rejects a second signup attempt against an already-accepted invite", async ({
  expect,
}) => {
  const now = new Date();
  await db.insert(schema.orgs).values({
    id: "org_stanford",
    name: "Stanford",
    slug: "stanford",
    createdAt: now,
  });
  await db.insert(schema.invites).values({
    id: "invite_1",
    orgId: "org_stanford",
    email: "invited@example.com",
    token: "test-token",
    status: "accepted",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
  });

  await expect(
    auth.api.signUpEmail({
      body: {
        email: "invited@example.com",
        name: "Invited Researcher",
        password: "throwaway-not-used-by-magic-link",
      },
    }),
  ).rejects.toThrow();
});

it("rejects an expired invite", async ({ expect }) => {
  const now = new Date();
  await db.insert(schema.orgs).values({
    id: "org_stanford",
    name: "Stanford",
    slug: "stanford",
    createdAt: now,
  });
  await db.insert(schema.invites).values({
    id: "invite_1",
    orgId: "org_stanford",
    email: "invited@example.com",
    token: "test-token",
    status: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() - 1000),
  });

  await expect(
    auth.api.signUpEmail({
      body: {
        email: "invited@example.com",
        name: "Invited Researcher",
        password: "throwaway-not-used-by-magic-link",
      },
    }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && pnpm test && cd ../..
```

Expected: the invite-gate tests fail (no hook exists yet, so every signup either succeeds unconditionally or errors for unrelated reasons).

- [ ] **Step 3: Implement the hook**

In `apps/api/src/auth.ts`, add these imports:

```ts
import { APIError } from "better-auth/api";
import { eq, and } from "drizzle-orm";
```

Add a `databaseHooks` key to the `betterAuth({...})` call:

```ts
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const now = new Date();
          const [invite] = await db
            .select()
            .from(schema.invites)
            .where(
              and(
                eq(schema.invites.email, user.email.toLowerCase()),
                eq(schema.invites.status, "pending"),
              ),
            );

          if (!invite || invite.expiresAt.getTime() < now.getTime()) {
            throw new APIError("FORBIDDEN", {
              message:
                "This email has no pending invite. Ask your university admin for one.",
            });
          }

          return {
            data: {
              ...user,
              email: user.email.toLowerCase(),
              orgId: invite.orgId,
            },
          };
        },
        after: async (createdUser) => {
          await db
            .update(schema.invites)
            .set({ status: "accepted" })
            .where(eq(schema.invites.email, createdUser.email));
        },
      },
    },
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api && pnpm test && cd ../..
```

Expected: all tests pass (this task's 4 plus the earlier ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "Gate account creation on a pending invite, assign orgId on signup"
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
const FROM_ADDRESS = "invites@<your-domain>";
const APP_BASE_URL = "https://app.<your-domain>";

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
    { encoding: "utf-8" },
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

- [ ] **Step 3: Manual verification**

Run once against your real, deployed D1 database and onboarded email domain (both set up in Tasks 3 and 5):

```bash
pnpm invite --org "Test University" --email you+test1@<your-domain>
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

Create `apps/web/.env` (replace `<your-domain>`; this is a local-dev value — production sets the same var through your Cloudflare Pages project settings):

```
VITE_API_URL=https://api.<your-domain>
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
import { useSearch } from "wouter";
import { signIn } from "@/lib/auth-client";

export default function Login() {
  const search = new URLSearchParams(useSearch());
  const [email, setEmail] = useState(search.get("email") ?? "");
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

- [ ] **Step 5: Verify it renders**

```bash
pnpm --filter @benchy/web dev
```

Open `http://localhost:5173/login` (or whatever port Vite prints) in a browser and confirm the form renders with no console errors. Submitting it will fail against a real API until Task 10 wires routing and the API is deployed — that's expected at this point; just confirm the page itself mounts cleanly.

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

  if (!session.user.orgId) {
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

- [ ] **Step 3: Verify the golden path in a browser**

```bash
pnpm --filter @benchy/web dev
```

Open the app's root URL. Confirm you see the login page (since no session cookie exists yet). This is the full extent of what's verifiable without a deployed API and a real invite — end-to-end sign-in verification happens once Tasks 3–8 are deployed for real (`wrangler deploy` from `apps/api`, and your existing frontend deploy to Cloudflare Pages) and you run the invite script from Task 8 against your own email address.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "Add auth route guard to the frontend"
```

---

## Final manual end-to-end check (not automated)

Once Tasks 1–10 are all committed and both `apps/api` (via `wrangler deploy`) and `apps/web` (via your Cloudflare Pages deploy) are live on your real domain:

1. `pnpm invite --org "Your Test Org" --email <your own email>`
2. Open the link from the invite email.
3. Confirm you land signed in, on the real app (not the "almost there" holding page).
4. Try signing in with a second, uninvited email address and confirm you see the invite-required error instead of getting in.
