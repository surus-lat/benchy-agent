import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // The org's default judge model for evaluations (one of the agent's catalog);
  // null = the benchmark's own scoring.grader. A benchmark may override it
  // (benchJudgeOverrides).
  judgeModel: text("judgeModel"),
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

// An org's own email domain: anyone with a verified address there may sign in
// and joins that org, no invite needed. Stored lowercased, without the "@".
export const orgDomains = sqliteTable("orgDomains", {
  domain: text("domain").primaryKey(),
  orgId: text("orgId")
    .notNull()
    .references(() => orgs.id),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

// Public "Request Access" submissions from the landing page. One row per
// email; the owner reviews them (pnpm access-requests) and mints invites.
export const accessRequests = sqliteTable("accessRequests", {
  id: text("id").primaryKey(),
  orgName: text("orgName").notNull(),
  email: text("email").notNull().unique(),
  name: text("name"),
  message: text("message"),
  status: text("status", { enum: ["pending", "invited", "declined"] })
    .notNull()
    .default("pending"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
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

// One Hermes instance per org (Railway). The key itself is never in D1:
// `apiKeyRef` names the Worker secret that holds this org's API_SERVER_KEY.
export const orgAgentEndpoints = sqliteTable("orgAgentEndpoints", {
  orgId: text("orgId")
    .primaryKey()
    .references(() => orgs.id),
  baseUrl: text("baseUrl").notNull(),
  apiKeyRef: text("apiKeyRef").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

// The judge model one benchmark's evaluations run with, when the org chose one
// for this benchmark specifically. No row = the org's default (orgs.judgeModel),
// and if that is also null, the benchmark's own scoring.grader. A row is the
// override; clearing the override deletes the row.
export const benchJudgeOverrides = sqliteTable(
  "benchJudgeOverrides",
  {
    orgId: text("orgId")
      .notNull()
      .references(() => orgs.id),
    // The benchmark (workspace folder) this override is for.
    bench: text("bench").notNull(),
    judgeModel: text("judgeModel").notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.bench] })],
);

// A benchmark's findings report edited by hand in the platform. A row is the
// current edit (no history): it wins over the report.md the agent writes in
// the workspace, which stays intact; deleting the row shows the generated
// report again.
export const benchReportEdits = sqliteTable(
  "benchReportEdits",
  {
    orgId: text("orgId")
      .notNull()
      .references(() => orgs.id),
    // The benchmark (workspace folder) whose report this edit is for.
    bench: text("bench").notNull(),
    // The full edited markdown, title included.
    markdown: text("markdown").notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.bench] })],
);

// A chat thread with the agent. Per-user: read with userId, never orgId.
// Not keyed on the login session — sessions rotate, conversations persist.
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  orgId: text("orgId")
    .notNull()
    .references(() => orgs.id),
  // The session inside the org's Hermes this conversation maps to.
  hermesSessionId: text("hermesSessionId").notNull(),
  title: text("title"),
  // The benchmark (workspace folder) this conversation is about, so the
  // researcher finds it again from any device; "new" while one is being created.
  bench: text("bench"),
  // Set while a turn is in flight; the per-conversation lock (Hermes holds
  // no per-session lock, so two concurrent turns would race).
  turnStartedAt: integer("turnStartedAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

// What happened in an org's workspace, and who did it: the org's record of
// its work (benchmarks themselves live in the agent's workspace). Written by
// the Worker on the actions it serves; read by every member of the org.
export const activity = sqliteTable("activity", {
  id: text("id").primaryKey(),
  orgId: text("orgId")
    .notNull()
    .references(() => orgs.id),
  // Null once the user is deleted: the record of the work stays.
  userId: text("userId").references(() => user.id, { onDelete: "set null" }),
  // Name at the time, so the record reads the same after a rename or deletion.
  who: text("who").notNull(),
  bench: text("bench"),
  kind: text("kind").notNull(),
  detail: text("detail").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const conversationMessages = sqliteTable("conversationMessages", {
  id: text("id").primaryKey(),
  conversationId: text("conversationId")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

// WebAuthn passkeys (better-auth passkey plugin): a researcher's Touch ID /
// Face ID / Windows Hello credential, registered after their first sign-in.
export const passkey = sqliteTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("publicKey").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credentialID").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("deviceType").notNull(),
  backedUp: integer("backedUp", { mode: "boolean" }).notNull(),
  transports: text("transports"),
  createdAt: integer("createdAt", { mode: "timestamp" }),
  aaguid: text("aaguid"),
});
