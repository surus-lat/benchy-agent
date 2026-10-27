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
  /** The benchmark this conversation is about. ("new" came from the agent-first
   *  benchmark creation, removed 2026-10-15; older rows may still carry it.) */
  bench: benchSchema.optional(),
});
const tagSchema = z.object({ bench: benchSchema });
/** What the app reports itself (the rest is logged where it happens, below). */
const activitySchema = z.object({
  bench: benchSchema,
  kind: z.enum(["create", "delete", "approve", "evaluate", "report"]),
  detail: z.string().trim().min(1).max(300),
});

/** Edits to the same file by the same person within this window are one entry. */
const COALESCE_MS = 15 * 60 * 1000;
const turnSchema = z.object({ message: z.string().trim().min(1).max(20_000) });
/** A judge model id from the agent's catalog (the container checks it against
 *  its catalog when the evaluation starts; the Worker checks shape only), or
 *  null to clear the setting. */
const judgeModelSchema = z.string().trim().min(1).max(100);
/** A hand edit of a benchmark's report: the full markdown (title included),
 *  or null to drop the edit and show the generated report again. */
const reportEditSchema = z.object({
  bench: benchSchema,
  markdown: z.string().trim().min(1).max(100_000).nullable(),
});

/** A source's id in <bench>/sources.json ("conicet-179477", "pdf-…"). */
const SOURCE_ID = /^[a-z0-9-]{1,120}$/;
/** A checklist item's id ("respaldo", "it-4f2a…"): kept when the item is renamed. */
const ITEM_ID = /^[a-z0-9-]{1,40}$/;
/** The org's checklist for validating new material: 1–20 items. */
const checklistSchema = z.object({
  items: z
    .array(z.object({ id: z.string().regex(ITEM_ID).optional(), label: z.string().trim().min(1).max(200) }))
    .min(1)
    .max(20),
});
/** The items a member ticked for one source of a benchmark. */
const sourceValidationSchema = z.object({
  bench: benchSchema,
  sourceId: z.string().regex(SOURCE_ID),
  checked: z.array(z.string().regex(ITEM_ID)).max(50),
});

/** The placeholder checklist every org starts with (the issue's three
 *  examples; the concrete list is still to be defined). Migration 0007 seeded
 *  the orgs that existed at deploy; this covers orgs created after. */
const DEFAULT_CHECKLIST = [
  { id: "respaldo", label: "Respaldo editorial o institucional" },
  { id: "formato", label: "Formato legible: PDF con texto seleccionable" },
  { id: "trazabilidad", label: "Trazabilidad de la fuente: autoría, año y procedencia identificables" },
];

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

  app.use("/api/library/*", authed);
  app.use("/api/conversations/*", authed);
  app.use("/api/conversations", authed);
  app.use("/api/workspace/*", authed);
  app.use("/api/org/*", authed);
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

  // An evaluation runs in the container, not in a conversation: it never
  // waits for the researcher's chat nor blocks it, and its state outlives the page.
  app.get("/api/workspace/evaluation", async (c) => {
    const path = c.req.query("path");
    if (!path || path.length > 1000) return c.json({ error: "INVALID_PATH" }, 400);
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      return c.json(await agent.evaluation(path));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  app.post("/api/workspace/evaluation", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { path?: unknown; models?: unknown } | null;
    const path = body?.path;
    const models = body?.models;
    if (typeof path !== "string" || !path || path.length > 1000) return c.json({ error: "INVALID_PATH" }, 400);
    if (!Array.isArray(models) || models.length === 0 || models.length > 20 || !models.every((m) => typeof m === "string" && m && m.length <= 100)) {
      return c.json({ error: "INVALID_BODY" }, 400);
    }
    const user = c.get("user");
    const agent = await deps.agentFor(user.orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    // The judge these runs grade with: the benchmark's override, else the
    // org's default, else nothing — the container keeps the benchmark's own
    // scoring.grader (the system's default).
    const judge = await judgeFor(user.orgId, path.split("/")[0]);
    try {
      const result = await agent.startEvaluation(path, models as string[], judge.effective ?? undefined);
      if (result.status === "busy") return c.json({ ...(result.body as object), error: "EVALUATION_RUNNING" }, 409);
      if (result.status === "started") {
        await log(c.get("user"), path.split("/")[0], "evaluate", `evaluó ${models.length === 1 ? "un modelo" : `${models.length} modelos`}: ${models.join(", ")}`);
      }
      return c.json(result.body);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  app.post("/api/workspace/report", async (c) => {
    const path = c.req.query("path");
    if (!path || path.length > 1000) return c.json({ error: "INVALID_PATH" }, 400);
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const result = await agent.startReport(path);
      if (result.status === "busy") return c.json({ ...(result.body as object), error: "EVALUATION_RUNNING" }, 409);
      if (result.status === "started") await log(c.get("user"), path.split("/")[0], "report", "pidió el informe de hallazgos");
      return c.json(result.body);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // The benchmark's findings report as the platform shows and exports it: the
  // edit made by hand here when there is one (the generated report.md stays
  // intact in the workspace), else the generated one. Any org member may read.
  app.get("/api/workspace/report", async (c) => {
    const bench = c.req.query("bench") ?? "";
    if (!BENCH.test(bench)) return c.json({ error: "INVALID_BENCH" }, 400);
    const user = c.get("user");
    const [edit] = await db
      .select({ markdown: schema.benchReportEdits.markdown, updatedAt: schema.benchReportEdits.updatedAt })
      .from(schema.benchReportEdits)
      .where(and(eq(schema.benchReportEdits.orgId, user.orgId), eq(schema.benchReportEdits.bench, bench)))
      .limit(1);
    if (edit) return c.json({ bench, source: "edited", markdown: edit.markdown, updatedAt: edit.updatedAt });
    const agent = await deps.agentFor(user.orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const file = await agent.readFile(`${bench}/report.md`);
      return file
        ? c.json({ bench, source: "generated", markdown: file.content, updatedAt: new Date(file.modified * 1000) })
        : c.json({ bench, source: null, markdown: null, updatedAt: null });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // The hand edit of a benchmark's report: only the latest one is kept (saving
  // again overwrites; null drops the edit and the generated report shows
  // again). The workspace's report.md is never written from here.
  app.put("/api/workspace/report", async (c) => {
    const user = c.get("user");
    const parsed = reportEditSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const { bench, markdown } = parsed.data;
    const where = and(eq(schema.benchReportEdits.orgId, user.orgId), eq(schema.benchReportEdits.bench, bench));
    if (markdown === null) {
      await db.delete(schema.benchReportEdits).where(where);
      await log(user, bench, "edit", "volvió al informe generado");
      return c.json({ bench, source: null, markdown: null, updatedAt: null });
    }
    const updatedAt = new Date();
    await db
      .insert(schema.benchReportEdits)
      .values({ orgId: user.orgId, bench, markdown, updatedAt })
      .onConflictDoUpdate({ target: [schema.benchReportEdits.orgId, schema.benchReportEdits.bench], set: { markdown, updatedAt } });
    await log(user, bench, "edit", "editó el informe a mano");
    return c.json({ bench, source: "edited", markdown, updatedAt });
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

  app.post("/api/workspace/quality", async (c) => {
    const path = c.req.query("path");
    if (!path || path.length > 1000) return c.json({ error: "INVALID_PATH" }, 400);
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const report = await agent.quality(path);
      await log(c.get("user"), path.split("/")[0], "quality", "midió la calidad de las preguntas");
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
      if (result.ok) {
        const user = c.get("user");
        await log(user, body.bench, "paper", `agregó «${paper.title}»`);
        // New material starts pending: it passes the org's checklist before
        // the agent writes questions from it.
        await markPending(user.orgId, body.bench, result.source.id);
      }
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
      if (result.ok) {
        const user = c.get("user");
        await log(user, bench, "paper", `subió «${result.source.title}»`);
        await markPending(user.orgId, bench, result.source.id);
      }
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
      if (result.ok) {
        const user = c.get("user");
        await log(user, bench, "paper", `quitó ${id}`);
        await db
          .delete(schema.sourceValidations)
          .where(
            and(
              eq(schema.sourceValidations.orgId, user.orgId),
              eq(schema.sourceValidations.bench, bench),
              eq(schema.sourceValidations.sourceId, id),
            ),
          );
      }
      return c.json(result);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // Delete one question from a benchmark: the agent drops the row from
  // exam.jsonl and reindexes the questions saved in runs/ and review.json so
  // they keep pointing at the right question. Older runs keep scoring only the
  // questions that remain and the app flags them as stale (out of date) until a
  // new run is started.
  app.delete("/api/workspace/benchmark/question", async (c) => {
    const bench = c.req.query("bench") ?? "";
    const q = Number(c.req.query("q"));
    if (!BENCH.test(bench)) return c.json({ error: "INVALID_BENCH" }, 400);
    if (!Number.isInteger(q) || q < 1 || q > 10_000) return c.json({ error: "INVALID_BODY" }, 400);
    const user = c.get("user");
    const agent = await deps.agentFor(user.orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const result = await agent.removeQuestion(bench, q);
      if (result.ok) await log(user, bench, "exam", `eliminó la pregunta ${q}`);
      return c.json(result);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // Delete a benchmark: the agent removes its workspace folder (exam, sources,
  // runs, report) and the Worker drops the org's rows about it. Deleting is
  // permanent — the app asks for confirmation before calling this.
  app.delete("/api/workspace/benchmark", async (c) => {
    const bench = c.req.query("bench") ?? "";
    if (!BENCH.test(bench)) return c.json({ error: "INVALID_BENCH" }, 400);
    const user = c.get("user");
    const agent = await deps.agentFor(user.orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const result = await agent.removeBenchmark(bench);
      if (result.ok) {
        await db
          .delete(schema.sourceValidations)
          .where(and(eq(schema.sourceValidations.orgId, user.orgId), eq(schema.sourceValidations.bench, bench)));
        await db
          .delete(schema.benchReportEdits)
          .where(and(eq(schema.benchReportEdits.orgId, user.orgId), eq(schema.benchReportEdits.bench, bench)));
        await db
          .delete(schema.benchJudgeOverrides)
          .where(and(eq(schema.benchJudgeOverrides.orgId, user.orgId), eq(schema.benchJudgeOverrides.bench, bench)));
        await log(user, bench, "delete", `eliminó el benchmark ${bench}`);
      }
      return c.json(result);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // The validation state of a benchmark's sources, newest edits last. A source
  // without a row predates this feature: it counts as validated
  // (grandfathered) — the app shows it as such.
  app.get("/api/workspace/sources/validation", async (c) => {
    const bench = c.req.query("bench") ?? "";
    if (!BENCH.test(bench)) return c.json({ error: "INVALID_BENCH" }, 400);
    const rows = await db
      .select()
      .from(schema.sourceValidations)
      .where(and(eq(schema.sourceValidations.orgId, c.get("user").orgId), eq(schema.sourceValidations.bench, bench)));
    return c.json({ validations: rows.map(validationOut) });
  });

  // Ticks of the org's checklist for one source. The source is validated the
  // moment every item of the current checklist is ticked (who and when are
  // kept); once validated it stays validated — unticking later, or editing the
  // checklist after, does not take it back.
  app.put("/api/workspace/sources/validation", async (c) => {
    const user = c.get("user");
    const parsed = sourceValidationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const { bench, sourceId } = parsed.data;
    const items = await checklistFor(user.orgId);
    const known = new Set(items.map((i) => i.id));
    const checked = [...new Set(parsed.data.checked.filter((id) => known.has(id)))];
    const done = items.every((i) => checked.includes(i.id));
    const now = new Date();
    const where = and(
      eq(schema.sourceValidations.orgId, user.orgId),
      eq(schema.sourceValidations.bench, bench),
      eq(schema.sourceValidations.sourceId, sourceId),
    );
    const [existing] = await db.select().from(schema.sourceValidations).where(where).limit(1);
    const firstTime = !existing?.validatedAt && done;
    const row = {
      orgId: user.orgId,
      bench,
      sourceId,
      checked: JSON.stringify(checked),
      validatedAt: existing?.validatedAt ?? (done ? now : null),
      validatedBy: existing?.validatedBy ?? (firstTime ? user.id : null),
      validatedByName: existing?.validatedByName ?? (firstTime ? user.name.trim() || user.email : null),
      updatedAt: now,
    };
    await db
      .insert(schema.sourceValidations)
      .values(row)
      .onConflictDoUpdate({
        target: [schema.sourceValidations.orgId, schema.sourceValidations.bench, schema.sourceValidations.sourceId],
        set: {
          checked: row.checked,
          validatedAt: row.validatedAt,
          validatedBy: row.validatedBy,
          validatedByName: row.validatedByName,
          updatedAt: row.updatedAt,
        },
      });
    return c.json({ validation: validationOut(row) });
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

  // Semantic search in the library: embed the query through the org's agent,
  // then POST the vector to the library's /api/library/semantic endpoint
  // (handled by the Worker's library app directly — not through this app).
  // This convenience route lets the web UI do semantic search in one call.
  app.post("/api/library/semantic-search", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { q?: unknown; k?: unknown; pdf?: unknown } | null;
    const q = typeof body?.q === "string" ? body.q.trim() : "";
    if (!q) return c.json({ error: "EMPTY_QUERY" }, 400);
    const agent = await deps.agentFor(c.get("user").orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);
    try {
      const vector = await agent.embed(q);
      // Forward the vector to the library cosine-scan handler (same Worker).
      const origin = new URL(c.req.url).origin;
      const sem = await fetch(`${origin}/api/library/semantic`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Forward auth so the library handler authorizes the request.
          cookie: c.req.header("cookie") ?? "",
          authorization: c.req.header("authorization") ?? "",
        },
        body: JSON.stringify({ vector, k: body?.k, pdf: body?.pdf }),
      });
      // Relay the library response as-is (it returns { papers: [...] }).
      return new Response(sem.body, { status: sem.status, headers: sem.headers });
    } catch (err) {
      return agentFailure(c, err);
    }
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

  // The judge model an evaluation grades with. The org's default lives on its
  // row; a benchmark may override it (the override wins); with neither, the
  // benchmark's own scoring.grader judges (the system's default). Any member
  // may read and change both, like the rest of the org's workspace.
  app.get("/api/org/judge", async (c) => {
    const user = c.get("user");
    const [org] = await db
      .select({ judgeModel: schema.orgs.judgeModel })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, user.orgId))
      .limit(1);
    return c.json({ judgeModel: org?.judgeModel ?? null });
  });

  app.put("/api/org/judge", async (c) => {
    const user = c.get("user");
    const parsed = z
      .object({ judgeModel: judgeModelSchema.nullable() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    await db.update(schema.orgs).set({ judgeModel: parsed.data.judgeModel }).where(eq(schema.orgs.id, user.orgId));
    return c.json({ judgeModel: parsed.data.judgeModel });
  });


  /** Relative luminance (WCAG). Rejects colors too close to white or too dark. */
  function hexLuminance(hex: string): number {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const srgb = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  }

  // The org's visual identity (issue #5): an accent color and a tagline that
  // reports and publications co-brand with. Either may be null (back to the
  // platform default). Hex only, so the value can never smuggle CSS.
  app.patch("/api/org/branding", async (c) => {
    const user = c.get("user");
    const parsed = z
      .object({
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
        colorSecondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
        tagline: z.string().trim().max(120).nullable(),
        logoUrl: z.string().regex(/^https?:\/\//).max(2048).nullable().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    // Reject colors with extreme luminance (illegible on white paper)
    for (const hex of [parsed.data.color, parsed.data.colorSecondary].filter(Boolean) as string[]) {
      const lum = hexLuminance(hex);
      if (lum > 0.85 || lum < 0.03) return c.json({ error: "COLOR_LOW_CONTRAST", message: "Elegí un color con suficiente contraste sobre blanco." }, 400);
    }
    await db
      .update(schema.orgs)
      .set({ brandColor: parsed.data.color, brandColorSecondary: parsed.data.colorSecondary ?? undefined, brandTagline: parsed.data.tagline, brandLogoUrl: parsed.data.logoUrl ?? undefined })
      .where(eq(schema.orgs.id, user.orgId));
    await log(user, "", "org", parsed.data.color || parsed.data.tagline ? "actualizó la identidad visual de la organización" : "quitó la identidad visual de la organización");
    return c.json({ color: parsed.data.color, colorSecondary: parsed.data.colorSecondary ?? null, tagline: parsed.data.tagline, logoUrl: parsed.data.logoUrl ?? null });
  });

  // One benchmark's judge config: its override, the org's default, and which
  // of them the next evaluation runs with (source: "override" | "org" | "system").
  app.get("/api/workspace/judge", async (c) => {
    const bench = c.req.query("bench") ?? "";
    if (!BENCH.test(bench)) return c.json({ error: "INVALID_BENCH" }, 400);
    return c.json(await judgeFor(c.get("user").orgId, bench));
  });

  app.put("/api/workspace/judge", async (c) => {
    const user = c.get("user");
    const parsed = z
      .object({ bench: benchSchema, judgeModel: judgeModelSchema.nullable() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const { bench, judgeModel } = parsed.data;
    const where = and(eq(schema.benchJudgeOverrides.orgId, user.orgId), eq(schema.benchJudgeOverrides.bench, bench));
    if (judgeModel === null) {
      // No row: the org's default applies again.
      await db.delete(schema.benchJudgeOverrides).where(where);
    } else {
      await db
        .insert(schema.benchJudgeOverrides)
        .values({ orgId: user.orgId, bench, judgeModel, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [schema.benchJudgeOverrides.orgId, schema.benchJudgeOverrides.bench], set: { judgeModel, updatedAt: new Date() } });
    }
    return c.json(await judgeFor(user.orgId, bench));
  });

  // The org's checklist for validating new material before it can be a source.
  // Any member may read or edit it; only the latest version is kept (no
  // history), and editing it never re-validates material that already passed.
  app.get("/api/org/source-checklist", async (c) => {
    return c.json({ items: await checklistFor(c.get("user").orgId) });
  });

  app.put("/api/org/source-checklist", async (c) => {
    const user = c.get("user");
    const parsed = checklistSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const ids = parsed.data.items.flatMap((i) => (i.id ? [i.id] : []));
    if (new Set(ids).size !== ids.length) return c.json({ error: "INVALID_BODY" }, 400);
    const now = new Date();
    const items = parsed.data.items.map((it, i) => ({
      orgId: user.orgId,
      id: it.id ?? newId("it-"),
      label: it.label,
      position: i,
      createdAt: now,
    }));
    await db.delete(schema.sourceChecklistItems).where(eq(schema.sourceChecklistItems.orgId, user.orgId));
    await db.insert(schema.sourceChecklistItems).values(items);
    return c.json({ items: items.map((it) => ({ id: it.id, label: it.label })) });
  });

  // Who is signed in, and their organization's display name.
  app.get("/api/me", async (c) => {
    const user = c.get("user");
    const [org] = await db
      .select({
        id: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        brandColor: schema.orgs.brandColor,
        brandColorSecondary: schema.orgs.brandColorSecondary,
        brandTagline: schema.orgs.brandTagline,
        brandLogoUrl: schema.orgs.brandLogoUrl,
      })
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

  /** The judge for one benchmark's next evaluation, always within the caller's
   *  org: the benchmark's override, else the org's default, else null — the
   *  benchmark's own scoring.grader ("system"). */
  async function judgeFor(orgId: string, bench: string) {
    const [override] = await db
      .select({ judgeModel: schema.benchJudgeOverrides.judgeModel })
      .from(schema.benchJudgeOverrides)
      .where(and(eq(schema.benchJudgeOverrides.orgId, orgId), eq(schema.benchJudgeOverrides.bench, bench)))
      .limit(1);
    const [org] = await db.select({ judgeModel: schema.orgs.judgeModel }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).limit(1);
    const orgDefault = org?.judgeModel ?? null;
    if (override) return { override: override.judgeModel, orgDefault, effective: override.judgeModel, source: "override" as const };
    if (orgDefault) return { override: null, orgDefault, effective: orgDefault, source: "org" as const };
    return { override: null, orgDefault, effective: null, source: "system" as const };
  }

  /** The org's checklist, materializing the placeholder one on first read
   *  (orgs created after migration 0007 seeded theirs). */
  async function checklistFor(orgId: string) {
    const existing = await db
      .select({ id: schema.sourceChecklistItems.id, label: schema.sourceChecklistItems.label })
      .from(schema.sourceChecklistItems)
      .where(eq(schema.sourceChecklistItems.orgId, orgId))
      .orderBy(asc(schema.sourceChecklistItems.position));
    if (existing.length) return existing;
    const now = new Date();
    await db
      .insert(schema.sourceChecklistItems)
      .values(DEFAULT_CHECKLIST.map((it, i) => ({ orgId, id: it.id, label: it.label, position: i, createdAt: now })))
      .onConflictDoNothing();
    return DEFAULT_CHECKLIST.map((it) => ({ id: it.id, label: it.label }));
  }

  /** A source added from the platform starts pending: it passes the org's
   *  checklist before the agent writes questions from it. Re-adding one that
   *  was removed starts it over. */
  async function markPending(orgId: string, bench: string, sourceId: string) {
    const now = new Date();
    await db
      .insert(schema.sourceValidations)
      .values({ orgId, bench, sourceId, checked: "[]", validatedAt: null, validatedBy: null, validatedByName: null, updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.sourceValidations.orgId, schema.sourceValidations.bench, schema.sourceValidations.sourceId],
        set: { checked: "[]", validatedAt: null, validatedBy: null, validatedByName: null, updatedAt: now },
      });
  }

  function validationOut(r: typeof schema.sourceValidations.$inferSelect) {
    let checked: string[] = [];
    try {
      const v = JSON.parse(r.checked) as unknown;
      if (Array.isArray(v)) checked = v.filter((x): x is string => typeof x === "string");
    } catch {
      // Our own writes are JSON; a corrupted row reads as nothing ticked.
    }
    return { sourceId: r.sourceId, checked, validatedAt: r.validatedAt, validatedByName: r.validatedByName };
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
