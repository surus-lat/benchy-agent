import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import { HermesError, type HermesClient } from "./hermes";
import type { Paper } from "./library";

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
  /** A paper from the library, to add to a benchmark. */
  paper: (id: number) => Promise<Paper | null>;
};

/** The container accepts up to 25 MB per request. */
const MAX_PDF_BYTES = 24 * 1024 * 1024;

/** A turn older than this is presumed dead (Worker evicted mid-turn) and its lock is reclaimable. */
const STALE_TURN_MS = 15 * 60 * 1000;

/** A benchmark is a top-level workspace folder; the container checks it has a benchmark.yaml. */
const BENCH = /^[^./\\][^/\\]{0,99}$/;
const benchSchema = z.string().regex(BENCH);

const createSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  /** The benchmark this conversation is about ("new" while one is being created). */
  bench: benchSchema.optional(),
});
const tagSchema = z.object({ bench: benchSchema });
/** What the app reports itself (the rest is logged where it happens, below). */
const activitySchema = z.object({
  bench: benchSchema,
  kind: z.enum(["create", "approve", "evaluate", "report"]),
  detail: z.string().trim().min(1).max(300),
});

/** Edits to the same file by the same person within this window are one entry. */
const COALESCE_MS = 15 * 60 * 1000;
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
  app.use("/api/activity", authed);

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
      bench: parsed.data.bench ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.conversations).values(row);
    return c.json({ id: row.id, title: row.title, bench: row.bench, createdAt: row.createdAt }, 201);
  });

  // The caller's conversations, newest first; ?bench= narrows to one benchmark's.
  app.get("/api/conversations", async (c) => {
    const user = c.get("user");
    const bench = c.req.query("bench");
    if (bench !== undefined && !BENCH.test(bench)) return c.json({ error: "INVALID_BENCH" }, 400);
    const rows = await db
      .select({
        id: schema.conversations.id,
        title: schema.conversations.title,
        bench: schema.conversations.bench,
        updatedAt: schema.conversations.updatedAt,
      })
      .from(schema.conversations)
      .where(
        bench === undefined
          ? eq(schema.conversations.userId, user.id)
          : and(eq(schema.conversations.userId, user.id), eq(schema.conversations.bench, bench)),
      )
      .orderBy(desc(schema.conversations.updatedAt))
      .limit(200);
    return c.json({ conversations: rows });
  });

  // Move a conversation to a benchmark (the one the agent just created from "new").
  app.patch("/api/conversations/:id", async (c) => {
    const user = c.get("user");
    const parsed = tagSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const updated = await db
      .update(schema.conversations)
      .set({ bench: parsed.data.bench })
      .where(and(eq(schema.conversations.id, c.req.param("id")), eq(schema.conversations.userId, user.id)))
      .returning({ id: schema.conversations.id });
    if (updated.length === 0) return c.json({ error: "NOT_FOUND" }, 404);
    return c.json({ id: updated[0].id, bench: parsed.data.bench });
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
      // The org sees that someone worked with the agent on a benchmark, never what was said.
      if (conversation.bench && conversation.bench !== "new") {
        await log(user, conversation.bench, "agent", "trabajó con el agente");
      }
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
    ["/api/workspace/analysis", (a: HermesClient, p: string) => a.analysis(p)],
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

  // The app's editors write benchmark text files (questions, answers, rubric).
  // Any org member may edit; the container refuses run results and anything
  // that is not a benchmark text file, and a file changed since it was read.
  app.put("/api/workspace/file", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { path?: unknown; content?: unknown; baseModified?: unknown } | null;
    const path = body?.path;
    const content = body?.content;
    const baseModified = body?.baseModified;
    if (typeof path !== "string" || !path || path.length > 1000) return c.json({ error: "INVALID_PATH" }, 400);
    if (typeof content !== "string") return c.json({ error: "INVALID_CONTENT" }, 400);
    if (baseModified !== undefined && typeof baseModified !== "number") return c.json({ error: "INVALID_CONTENT" }, 400);
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const result = await agent.writeFile(path, content, baseModified);
      if (result.status === "conflict") return c.json({ error: "CONFLICT", modified: result.modified }, 409);
      if (result.status === "forbidden") return c.json({ error: "FORBIDDEN_PATH" }, 403);
      if (result.status === "too_large") return c.json({ error: "TOO_LARGE" }, 413);
      const [bench, ...rest] = result.path.split("/");
      await log(c.get("user"), bench, "edit", rest.join("/"));
      return c.json({ path: result.path, modified: result.modified });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  app.post("/api/workspace/review", async (c) => {
    const path = c.req.query("path");
    if (!path || path.length > 1000) return c.json({ error: "INVALID_PATH" }, 400);
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const report = await agent.review(path);
      await log(c.get("user"), path.split("/")[0], "review", "revisión del juez de las respuestas expertas");
      return c.json(report);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // A benchmark's papers: the sources the agent writes its questions from.
  // Any org member may add or remove one; the container fetches and keeps the text.
  app.post("/api/workspace/sources", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { bench?: unknown; paperId?: unknown } | null;
    if (typeof body?.bench !== "string" || !BENCH.test(body.bench)) return c.json({ error: "INVALID_BENCH" }, 400);
    if (typeof body.paperId !== "number" || !Number.isSafeInteger(body.paperId)) return c.json({ error: "INVALID_BODY" }, 400);
    const paper = await deps.paper(body.paperId);
    if (!paper) return c.json({ error: "PAPER_NOT_FOUND" }, 404);
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const result = await agent.addSource(body.bench, paper);
      if (result.ok) await log(c.get("user"), body.bench, "paper", `agregó «${paper.title}»`);
      return c.json(result);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  app.post("/api/workspace/sources/upload", async (c) => {
    const bench = c.req.query("bench") ?? "";
    const name = (c.req.query("name") ?? "").trim();
    if (!BENCH.test(bench)) return c.json({ error: "INVALID_BENCH" }, 400);
    if (!name || name.length > 200) return c.json({ error: "INVALID_BODY" }, 400);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_PDF_BYTES) return c.json({ error: "TOO_LARGE" }, 413);
    const pdf = await c.req.arrayBuffer();
    if (pdf.byteLength > MAX_PDF_BYTES) return c.json({ error: "TOO_LARGE" }, 413);
    // The header may follow some junk, within the first 1024 bytes (PDF 1.7, 7.5.2).
    const head = new Uint8Array(pdf, 0, Math.min(1024, pdf.byteLength));
    if (!String.fromCharCode(...head).includes("%PDF-")) return c.json({ error: "NOT_PDF" }, 415);
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const result = await agent.uploadSource(bench, name, pdf);
      if (result.ok) await log(c.get("user"), bench, "paper", `subió «${result.source.title}»`);
      return c.json(result);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  app.delete("/api/workspace/sources", async (c) => {
    const bench = c.req.query("bench") ?? "";
    const id = c.req.query("id") ?? "";
    if (!BENCH.test(bench)) return c.json({ error: "INVALID_BENCH" }, 400);
    if (!/^[a-z0-9-]{1,120}$/.test(id)) return c.json({ error: "INVALID_BODY" }, 400);
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const result = await agent.removeSource(bench, id);
      if (result.ok) await log(c.get("user"), bench, "paper", `quitó ${id}`);
      return c.json(result);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // The org's record of its work: who did what on which benchmark, newest first.
  app.get("/api/activity", async (c) => {
    const user = c.get("user");
    const bench = c.req.query("bench");
    if (bench !== undefined && !BENCH.test(bench)) return c.json({ error: "INVALID_BENCH" }, 400);
    const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const rows = await db
      .select({
        id: schema.activity.id,
        who: schema.activity.who,
        userId: schema.activity.userId,
        bench: schema.activity.bench,
        kind: schema.activity.kind,
        detail: schema.activity.detail,
        createdAt: schema.activity.createdAt,
      })
      .from(schema.activity)
      .where(
        bench === undefined
          ? eq(schema.activity.orgId, user.orgId)
          : and(eq(schema.activity.orgId, user.orgId), eq(schema.activity.bench, bench)),
      )
      .orderBy(desc(schema.activity.createdAt))
      .limit(limit);
    return c.json({ activity: rows });
  });

  // What only the app knows happened (an approval, an evaluation or a report it asked for).
  app.post("/api/activity", async (c) => {
    const parsed = activitySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    await log(c.get("user"), parsed.data.bench, parsed.data.kind, parsed.data.detail);
    return c.json({ ok: true }, 201);
  });

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

  /** One entry in the org's record; the same edit within COALESCE_MS only moves its time. */
  async function log(user: CurrentUser & { orgId: string }, bench: string, kind: string, detail: string) {
    const now = new Date();
    if (kind === "edit" || kind === "agent") {
      const touched = await db
        .update(schema.activity)
        .set({ createdAt: now })
        .where(
          and(
            eq(schema.activity.orgId, user.orgId),
            eq(schema.activity.userId, user.id),
            eq(schema.activity.bench, bench),
            eq(schema.activity.kind, kind),
            eq(schema.activity.detail, detail),
            gt(schema.activity.createdAt, new Date(now.getTime() - COALESCE_MS)),
          ),
        )
        .returning({ id: schema.activity.id });
      if (touched.length) return;
    }
    await db.insert(schema.activity).values({
      id: newId("act_"),
      orgId: user.orgId,
      userId: user.id,
      who: user.name.trim() || user.email,
      bench,
      kind,
      detail,
      createdAt: now,
    });
  }

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
