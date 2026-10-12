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
  // Set while a turn is in flight; the per-conversation lock (Hermes holds
  // no per-session lock, so two concurrent turns would race).
  turnStartedAt: integer("turnStartedAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
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
