import { Hono } from "hono";
import { and, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import type { HermesClient } from "./hermes";
import type { CurrentUser } from "./conversations";

// Global process indicators (issue #7): what is running in the platform right
// now, and what just finished or failed.
//
// Visibility (product decision): the caller sees
//   a) their OWN processes — an agent turn in flight in one of their
//      conversations (question generation and any other batch work the agent
//      does inside a turn), and
//   b) the EVALUATIONS of their whole organization (and report generation,
//      which runs inside the same container job).
// Never another user's turns, and never anything from another org: turns are
// read with userId = the caller, evaluation events with orgId = the caller's
// org, and the live state comes from that org's own container.
//
// What today's tables can say: a turn leaves a lock while it runs (a stale
// lock reads as a failure), an evaluation/report start is an activity event,
// and its live state is the container's <bench>/evaluation.json. Finished or
// failed turns and batches leave no trace — that history is the wave-2
// schema extension (a processes table with status/startedAt/finishedAt/error).

type Db = DrizzleD1Database<typeof schema>;

export type ProcessesDeps = {
  db: Db;
  currentUser: (request: Request) => Promise<CurrentUser | null>;
  agentFor: (orgId: string) => Promise<HermesClient | null>;
};

/** Same rule as the turn route: a lock older than this is presumed dead. */
const STALE_TURN_MS = 15 * 60 * 1000;
/** A start event older than this with no live state is no longer news. */
const LIVE_WINDOW_MS = 15 * 60 * 1000;
/** Evaluation/report events considered at all; finished ones stay visible this long. */
const RECENT_MS = 24 * 60 * 60 * 1000;
/** Never ask the container about more benches than this in one request. */
const MAX_BENCH_LOOKUPS = 10;

export type ProcessStatus = "running" | "done" | "failed";
export type ProcessType = "evaluation" | "report" | "agent";

export type ProcessItem = {
  id: string;
  type: ProcessType;
  status: ProcessStatus;
  bench: string | null;
  /** Who started it, for the org's evaluations; null on the caller's own turn. */
  who: string | null;
  mine: boolean;
  detail: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

/** The container's <bench>/evaluation.json (times are epoch seconds). */
type EvaluationState = {
  state?: string;
  started?: number | null;
  finished?: number | null;
};

export function createProcessesApp(deps: ProcessesDeps) {
  const { db } = deps;
  const app = new Hono<{ Variables: { user: CurrentUser & { orgId: string } } }>();

  app.use("/api/processes", authed);

  async function authed(c: any, next: () => Promise<void>) {
    const user = await deps.currentUser(c.req.raw);
    if (!user) return c.json({ error: "UNAUTHENTICATED" }, 401);
    if (!user.orgId) return c.json({ error: "NO_ORG" }, 403);
    c.set("user", user);
    await next();
  }

  app.get("/api/processes", async (c) => {
    const user = c.get("user");
    const now = Date.now();
    const processes: ProcessItem[] = [];

    // (a) The caller's own turns in flight. Conversations are per-user: the
    // query carries userId = the caller, so nobody else's turn can appear.
    const turns = await db
      .select({
        id: schema.conversations.id,
        bench: schema.conversations.bench,
        turnStartedAt: schema.conversations.turnStartedAt,
      })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.userId, user.id), isNotNull(schema.conversations.turnStartedAt)));
    for (const turn of turns) {
      const started = turn.turnStartedAt as Date;
      processes.push({
        id: `turn:${turn.id}`,
        type: "agent",
        status: now - started.getTime() >= STALE_TURN_MS ? "failed" : "running",
        bench: turn.bench && turn.bench !== "new" ? turn.bench : null,
        who: null,
        mine: true,
        detail: null,
        startedAt: started,
        finishedAt: null,
      });
    }

    // (b) The org's evaluations and reports: the latest start event per bench
    // (orgId = the caller's org in the query), plus the live state from that
    // org's own container.
    const events = await db
      .select({
        userId: schema.activity.userId,
        who: schema.activity.who,
        bench: schema.activity.bench,
        kind: schema.activity.kind,
        detail: schema.activity.detail,
        createdAt: schema.activity.createdAt,
      })
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.orgId, user.orgId),
          inArray(schema.activity.kind, ["evaluate", "report"]),
          isNotNull(schema.activity.bench),
          gt(schema.activity.createdAt, new Date(now - RECENT_MS)),
        ),
      )
      .orderBy(desc(schema.activity.createdAt))
      .limit(100);
    const latestByBench = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (!latestByBench.has(event.bench as string)) latestByBench.set(event.bench as string, event);
    }

    const agent = await deps.agentFor(user.orgId);
    const states = new Map<string, EvaluationState | null>();
    if (agent) {
      await Promise.all(
        [...latestByBench.keys()].slice(0, MAX_BENCH_LOOKUPS).map(async (bench) => {
          try {
            const res = (await agent.evaluation(`${bench}/benchmark.yaml`)) as {
              ok?: boolean;
              evaluation?: EvaluationState | null;
            };
            states.set(bench, res?.ok ? (res.evaluation ?? null) : null);
          } catch {
            states.set(bench, null); // unreachable: fall back to the event's age
          }
        }),
      );
    }

    for (const [bench, event] of latestByBench) {
      // undefined when the bench was not looked up (cap, or no container).
      const live = states.get(bench)?.state;
      let status: ProcessStatus;
      if (live === "running" || live === "reporting") status = "running";
      else if (live === "done") status = "done";
      else if (live === "error" || live === "interrupted") status = "failed";
      else {
        // No live state (never written, wiped, or the bench does not compile
        // right now): a start this fresh is still happening; older is not news.
        if (now - event.createdAt.getTime() >= LIVE_WINDOW_MS) continue;
        status = "running";
      }
      const state = states.get(bench);
      processes.push({
        id: `${event.kind}:${bench}`,
        type: event.kind === "report" ? "report" : "evaluation",
        status,
        bench,
        who: event.who,
        mine: event.userId === user.id,
        detail: event.detail,
        startedAt: state?.started ? new Date(state.started * 1000) : event.createdAt,
        finishedAt: status !== "running" && state?.finished ? new Date(state.finished * 1000) : null,
      });
    }

    processes.sort((a, b) => {
      const rank = (p: ProcessItem) => (p.status === "running" ? 0 : 1);
      return rank(a) - rank(b) || b.startedAt.getTime() - a.startedAt.getTime();
    });
    return c.json({ processes });
  });

  return app;
}
