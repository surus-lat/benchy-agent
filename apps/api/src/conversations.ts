import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import { HermesError, type HermesClient } from "./hermes";

// Browser ↔ Worker routes for talking to the org's agent. Every route is
// authenticated; conversations are per-user (read with userId, never orgId);
// the org comes from the session, never from the request.

type Db = DrizzleD1Database<typeof schema>;

export type CurrentUser = { id: string; name: string; email: string; orgId: string | null };

export type ConversationsDeps = {
  db: Db;
  currentUser: (request: Request) => Promise<CurrentUser | null>;
  /** The org's Hermes, or null when the org has not been provisioned. */
  agentFor: (orgId: string) => Promise<HermesClient | null>;
};

/** A turn older than this is presumed dead (Worker evicted mid-turn) and its lock is reclaimable. */
const STALE_TURN_MS = 15 * 60 * 1000;

const createSchema = z.object({ title: z.string().trim().min(1).max(200).optional() });
const turnSchema = z.object({ message: z.string().trim().min(1).max(20_000) });

function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Who is speaking, sent to Hermes as the turn's ephemeral system message. */
export function speakerLine(user: CurrentUser): string {
  const who = user.name.trim() || user.email;
  return `The researcher speaking is ${who} (${user.email}, user ${user.id}). Address them by name.`;
}

function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > 60 ? line.slice(0, 57) + "…" : line;
}

export function createConversationsApp(deps: ConversationsDeps) {
  const { db } = deps;
  const app = new Hono<{ Variables: { user: CurrentUser & { orgId: string } } }>();

  app.use("/api/conversations/*", authed);
  app.use("/api/conversations", authed);
  app.use("/api/workspace/*", authed);
  app.use("/api/models", authed);
  app.use("/api/me", authed);

  async function authed(c: any, next: () => Promise<void>) {
    const user = await deps.currentUser(c.req.raw);
    if (!user) return c.json({ error: "UNAUTHENTICATED" }, 401);
    if (!user.orgId) return c.json({ error: "NO_ORG" }, 403);
    c.set("user", user);
    await next();
  }

  app.post("/api/conversations", async (c) => {
    const user = c.get("user");
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);

    const agent = await deps.agentFor(user.orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);

    // No Hermes session, no conversation: that row would be unusable.
    let hermesSessionId: string;
    try {
      hermesSessionId = await agent.createSession(user.id);
    } catch (err) {
      return agentFailure(c, err);
    }

    const now = new Date();
    const row = {
      id: newId("conv_"),
      userId: user.id,
      orgId: user.orgId,
      hermesSessionId,
      title: parsed.data.title ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.conversations).values(row);
    return c.json({ id: row.id, title: row.title, createdAt: row.createdAt }, 201);
  });

  app.get("/api/conversations", async (c) => {
    const user = c.get("user");
    const rows = await db
      .select({
        id: schema.conversations.id,
        title: schema.conversations.title,
        updatedAt: schema.conversations.updatedAt,
      })
      .from(schema.conversations)
      .where(eq(schema.conversations.userId, user.id))
      .orderBy(desc(schema.conversations.updatedAt))
      .limit(200);
    return c.json({ conversations: rows });
  });

  app.get("/api/conversations/:id/messages", async (c) => {
    const user = c.get("user");
    const conversation = await ownConversation(c.req.param("id"), user.id);
    if (!conversation) return c.json({ error: "NOT_FOUND" }, 404);
    const messages = await db
      .select({
        id: schema.conversationMessages.id,
        role: schema.conversationMessages.role,
        content: schema.conversationMessages.content,
        createdAt: schema.conversationMessages.createdAt,
      })
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversationId, conversation.id))
      // Insertion order, not createdAt: timestamps are whole seconds, so a
      // question and its reply often share one and would sort by random id.
      .orderBy(asc(sql`rowid`));
    return c.json({ messages });
  });

  app.post("/api/conversations/:id/turns", async (c) => {
    const user = c.get("user");
    const parsed = turnSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const { message } = parsed.data;

    const conversation = await ownConversation(c.req.param("id"), user.id);
    if (!conversation) return c.json({ error: "NOT_FOUND" }, 404);

    const agent = await deps.agentFor(user.orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);

    // Take the per-conversation lock atomically; a second turn gets 409.
    const now = new Date();
    const locked = await db
      .update(schema.conversations)
      .set({ turnStartedAt: now })
      .where(
        and(
          eq(schema.conversations.id, conversation.id),
          eq(schema.conversations.userId, user.id),
          or(
            isNull(schema.conversations.turnStartedAt),
            lt(schema.conversations.turnStartedAt, new Date(now.getTime() - STALE_TURN_MS)),
          ),
        ),
      )
      .returning({ id: schema.conversations.id });
    if (locked.length === 0) return c.json({ error: "TURN_IN_PROGRESS" }, 409);

    try {
      await db.insert(schema.conversationMessages).values({
        id: newId("msg_"),
        conversationId: conversation.id,
        role: "user",
        content: message,
        createdAt: now,
      });

      let turn;
      try {
        turn = await agent.chat(conversation.hermesSessionId, user.id, message, speakerLine(user));
      } catch (err) {
        return agentFailure(c, err);
      }

      const repliedAt = new Date();
      await db.insert(schema.conversationMessages).values({
        id: newId("msg_"),
        conversationId: conversation.id,
        role: "assistant",
        content: turn.reply,
        createdAt: repliedAt,
      });
      await db
        .update(schema.conversations)
        .set({ updatedAt: repliedAt, title: conversation.title ?? titleFrom(message) })
        .where(eq(schema.conversations.id, conversation.id));
      return c.json({ reply: turn.reply, usage: turn.usage });
    } finally {
      await db
        .update(schema.conversations)
        .set({ turnStartedAt: null })
        .where(eq(schema.conversations.id, conversation.id));
    }
  });

  // The org's workspace — benchmarks are org-visible, so any member may read.
  app.get("/api/workspace/files", async (c) => {
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      return c.json(await agent.listFiles());
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  app.get("/api/workspace/file", async (c) => {
    const path = c.req.query("path");
    if (!path || path.length > 1000) return c.json({ error: "INVALID_PATH" }, 400);
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const file = await agent.readFile(path);
      return file ? c.json(file) : c.json({ error: "NOT_FOUND" }, 404);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // Engine checks for the app, through the org's container (read-only).
  for (const [route, call] of [
    ["/api/workspace/validate", (a: HermesClient, p: string) => a.validate(p)],
    ["/api/workspace/exam", (a: HermesClient, p: string) => a.exam(p)],
  ] as const) {
    app.get(route, async (c) => {
      const path = c.req.query("path");
      if (!path || path.length > 1000) return c.json({ error: "INVALID_PATH" }, 400);
      const agent = await deps.agentFor(c.get("user").orgId);
      if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
      try {
        return c.json(await call(agent, path));
      } catch (err) {
        return agentFailure(c, err);
      }
    });
  }

  app.get("/api/models", async (c) => {
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      return c.json(await agent.models());
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // Who is signed in, and their organization's display name.
  app.get("/api/me", async (c) => {
    const user = c.get("user");
    const [org] = await db
      .select({ id: schema.orgs.id, name: schema.orgs.name })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, user.orgId))
      .limit(1);
    return c.json({ user: { id: user.id, name: user.name, email: user.email }, org: org ?? null });
  });

  async function ownConversation(id: string, userId: string) {
    const [row] = await db
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, id), eq(schema.conversations.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  function agentFailure(c: any, err: unknown) {
    if (err instanceof HermesError) {
      console.error(`agent call failed: ${err.message}`);
      return c.json({ error: err.status === 504 ? "AGENT_TIMEOUT" : "AGENT_UNAVAILABLE" }, err.status);
    }
    throw err;
  }

  return app;
}
