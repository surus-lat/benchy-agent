import { Hono } from "hono";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import { HermesError, type HermesClient } from "./hermes";
import type { CurrentUser } from "./conversations";

// Peer review of questions inside the org (issue #1): every member of the org
// sees every question of every benchmark and marks it valida (+1) or rechaza
// (-1). The engine is never touched: questions are read through the org's
// agent (listFiles + exam), and the votes live only in D1. A vote is keyed by
// the question's 1-based position and the sha256 of its trimmed text (qHash):
// if the question is edited, its old votes no longer match the text and are
// hidden silently — the member can vote again on the new text.
//
// Everything is scoped to the caller's org (from the session, never from the
// request): one org never sees or changes another's votes.

type Db = DrizzleD1Database<typeof schema>;

export type PeerReviewDeps = {
  db: Db;
  currentUser: (request: Request) => Promise<CurrentUser | null>;
  /** The org's Hermes, or null when the org has not been provisioned. */
  agentFor: (orgId: string) => Promise<HermesClient | null>;
};

/** A benchmark is a top-level workspace folder (same shape as conversations.ts). */
const BENCH = /^[^./\\][^/\\]{0,99}$/;
const benchSchema = z.string().regex(BENCH);
const voteSchema = z.object({
  bench: benchSchema,
  q: z.number().int().min(1).max(10_000),
  // sha256 hex of the trimmed question text the member voted on.
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  // +1 valida, -1 rechaza, 0 clears the caller's vote.
  vote: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
});

/** Questions listed per org request: the page is for reviewing a handful of
 *  benchmarks, not for dumping a huge workspace (exam caps rows per bench). */
const MAX_QUESTIONS = 500;
/** The expected answer travels to the page only as a short hint. */
const MAX_ANSWER_CHARS = 500;

function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A string anywhere in a question/answer payload: input/expected are
 *  program-typed — usually a plain string, possibly a nested object. */
function firstText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = firstText(v);
      if (t) return t;
    }
    return "";
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const t = firstText(v);
      if (t) return t;
    }
  }
  return value == null ? "" : String(value);
}

/** sha256 hex of the trimmed text: what a vote is actually about. */
async function questionHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.trim()));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createPeerReviewApp(deps: PeerReviewDeps) {
  const { db } = deps;
  const app = new Hono<{ Variables: { user: CurrentUser & { orgId: string } } }>();

  app.use("/api/org/questions", authed);
  app.use("/api/org/questions/*", authed);

  async function authed(c: any, next: () => Promise<void>) {
    const user = await deps.currentUser(c.req.raw);
    if (!user) return c.json({ error: "UNAUTHENTICATED" }, 401);
    if (!user.orgId) return c.json({ error: "NO_ORG" }, 403);
    c.set("user", user);
    await next();
  }

  // Every question of the org's benchmarks with its current peer tally.
  app.get("/api/org/questions", async (c) => {
    const user = c.get("user");
    const agent = await deps.agentFor(user.orgId);
    if (!agent) return c.json({ error: "AGENT_NOT_PROVISIONED" }, 503);

    let listing: { files: { path: string }[] };
    try {
      listing = await agent.listFiles();
    } catch (err) {
      return agentFailure(c, err);
    }
    // A benchmark folder is one that has a benchmark.yaml at its top
    // (same derivation as benchesFrom in the web app).
    const benches = [...new Set(
      listing.files
        .map((f) => f.path.split("/"))
        .filter((parts) => parts.length === 2 && parts[1] === "benchmark.yaml" && BENCH.test(parts[0]))
        .map((parts) => parts[0]),
    )].sort();

    // The org's stored votes, grouped per question. updatedAt ascending so the
    // latest row of a member is the last one seen when tallying.
    const stored = await db
      .select({
        bench: schema.questionValidations.bench,
        q: schema.questionValidations.q,
        qHash: schema.questionValidations.qHash,
        userId: schema.questionValidations.userId,
        vote: schema.questionValidations.vote,
      })
      .from(schema.questionValidations)
      .where(eq(schema.questionValidations.orgId, user.orgId))
      .orderBy(asc(schema.questionValidations.updatedAt));
    const byQuestion = new Map<string, typeof stored>();
    for (const row of stored) {
      const key = `${row.bench}#${row.q}`;
      const list = byQuestion.get(key) ?? [];
      list.push(row);
      byQuestion.set(key, list);
    }

    const questions: {
      bench: string;
      q: number;
      question: string;
      expectedAnswer: string | null;
      hash: string;
      votes: { up: number; down: number };
      myVote: number | null;
      validated: boolean;
    }[] = [];
    // Sequential, one bench at a time: two calls each, and the cap stops the
    // loop before the workspace grows past what one page should show.
    for (const bench of benches) {
      if (questions.length >= MAX_QUESTIONS) break;
      let examResult: unknown;
      try {
        examResult = await agent.exam(`${bench}/benchmark.yaml`);
      } catch (err) {
        if (err instanceof HermesError) return agentFailure(c, err);
        continue; // one broken bench must not blank the whole page
      }
      const exam = examResult as { ok?: boolean; rows?: { input?: unknown; expected?: unknown; status?: string }[] };
      if (!exam || exam.ok !== true || !Array.isArray(exam.rows)) continue;
      let q = 0;
      for (const row of exam.rows) {
        // Positions follow the file's rows, as everywhere else in the app
        // (the agent's delete reindexes positions).
        q += 1;
        if (!row || row.status !== "valid") continue;
        const text = firstText(row.input).trim();
        if (!text) continue;
        const hash = await questionHash(text);
        // Only votes whose hash matches the current text count; the unique
        // index keeps one live row per member, and rows whose user was
        // deleted stay as extra votes for the text they were cast on.
        const current = (byQuestion.get(`${bench}#${q}`) ?? []).filter((v) => v.qHash === hash);
        const up = current.filter((v) => v.vote === 1).length;
        const down = current.filter((v) => v.vote === -1).length;
        const mine = current.toReversed().find((v) => v.userId === user.id) ?? null;
        questions.push({
          bench,
          q,
          question: text,
          expectedAnswer: firstText(row.expected).trim().slice(0, MAX_ANSWER_CHARS) || null,
          hash,
          votes: { up, down },
          myVote: mine?.vote ?? null,
          // Two distinct validations, more validates than rejections, over
          // the current text: one lone thumbs-up never validates a question.
          validated: up >= 2 && up - down > 0,
        });
        if (questions.length >= MAX_QUESTIONS) break;
      }
    }
    return c.json({ questions, truncated: questions.length >= MAX_QUESTIONS });
  });

  // One member's vote on one question: +1 valida, -1 rechaza, 0 clears. The
  // unique (orgId, bench, q, userId) row is the member's current vote.
  app.post("/api/org/questions/vote", async (c) => {
    const user = c.get("user");
    const parsed = voteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const { bench, q, hash, vote } = parsed.data;
    const where = and(
      eq(schema.questionValidations.orgId, user.orgId),
      eq(schema.questionValidations.bench, bench),
      eq(schema.questionValidations.q, q),
      eq(schema.questionValidations.userId, user.id),
    );
    if (vote === 0) {
      await db.delete(schema.questionValidations).where(where);
      await log(user, bench, `quitó su voto de la pregunta ${q}`);
      return c.json({ ok: true, bench, q, vote: null });
    }
    const now = new Date();
    await db
      .insert(schema.questionValidations)
      .values({
        id: newId("qv_"),
        orgId: user.orgId,
        bench,
        q,
        qHash: hash,
        userId: user.id,
        vote,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.questionValidations.orgId,
          schema.questionValidations.bench,
          schema.questionValidations.q,
          schema.questionValidations.userId,
        ],
        set: { qHash: hash, vote, updatedAt: now },
      });
    await log(user, bench, `marcó la pregunta ${q} como ${vote === 1 ? "válida" : "a rechazar"}`);
    return c.json({ ok: true, bench, q, vote });
  });

  async function log(user: CurrentUser & { orgId: string }, bench: string, detail: string) {
    await db.insert(schema.activity).values({
      id: newId("act_"),
      orgId: user.orgId,
      userId: user.id,
      who: user.name.trim() || user.email,
      bench,
      kind: "peer",
      detail,
      createdAt: new Date(),
    });
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
