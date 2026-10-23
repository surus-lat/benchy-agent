import { Hono } from "hono";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import type { CurrentUser } from "./conversations";

// The org's library of reusable evaluation criteria (issue #12): criteria the
// people wrote once, kept so a benchmark's "Criterios de evaluación" drawer
// adds them instead of retyping them, and new criteria are saved back.
//
// Everything is org-scoped: every query carries orgId = the caller's org, so
// one org never sees, edits, or deletes another's criteria. The library lives
// in D1 only; the benchmark's own copy still goes to benchmark.yaml (the app
// already writes it there), so no agent-side change is needed.

type Db = DrizzleD1Database<typeof schema>;

export type CriteriaLibraryDeps = {
  db: Db;
  currentUser: (request: Request) => Promise<CurrentUser | null>;
};

/** A criterion's importance, as in the drawer's WeightScale (1..5). */
const weightSchema = z.number().int().min(1).max(5);
/** The grade-wording map saved in benchmark.yaml: up to 10 grades, each a
 *  short sentence. Keys are non-negative integers ("0", "1"). */
const levelsSchema = z.record(z.string().regex(/^\d{1,2}$/), z.string().trim().min(1).max(300)).refine(
  (m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 10,
);
const criterionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000),
  weight: weightSchema,
  levels: levelsSchema,
});

function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A D1 row as the API returns it: levels back as an object, ISO timestamps. */
function view(row: typeof schema.benchCriteriaLibrary.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    weight: row.weight,
    levels: JSON.parse(row.levels) as Record<string, string>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createCriteriaLibraryApp(deps: CriteriaLibraryDeps) {
  const { db } = deps;
  const app = new Hono<{ Variables: { user: CurrentUser & { orgId: string } } }>();

  app.use("/api/criteria", authed);
  app.use("/api/criteria/*", authed);

  async function authed(c: any, next: () => Promise<void>) {
    const user = await deps.currentUser(c.req.raw);
    if (!user) return c.json({ error: "UNAUTHENTICATED" }, 401);
    if (!user.orgId) return c.json({ error: "NO_ORG" }, 403);
    c.set("user", user);
    await next();
  }

  /** The caller's own criterion, or null: the id alone never addresses a row. */
  async function ownCriterion(orgId: string, id: string) {
    const [row] = await db
      .select()
      .from(schema.benchCriteriaLibrary)
      .where(and(eq(schema.benchCriteriaLibrary.orgId, orgId), eq(schema.benchCriteriaLibrary.id, id)))
      .limit(1);
    return row ?? null;
  }

  app.get("/api/criteria", async (c) => {
    const user = c.get("user");
    const rows = await db
      .select()
      .from(schema.benchCriteriaLibrary)
      .where(eq(schema.benchCriteriaLibrary.orgId, user.orgId))
      .orderBy(asc(schema.benchCriteriaLibrary.createdAt));
    return c.json({ criteria: rows.map(view) });
  });

  app.post("/api/criteria", async (c) => {
    const user = c.get("user");
    const parsed = criterionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const now = new Date();
    const row = {
      orgId: user.orgId,
      id: newId("crit_"),
      ...parsed.data,
      levels: JSON.stringify(parsed.data.levels),
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.benchCriteriaLibrary).values(row);
    return c.json({ criterion: view(row) }, 201);
  });

  app.patch("/api/criteria/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    // Every field optional: the drawer edits one at a time.
    const parsed = criterionSchema.partial().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const existing = await ownCriterion(user.orgId, id);
    if (!existing) return c.json({ error: "NOT_FOUND" }, 404);
    const patch = {
      ...parsed.data,
      ...(parsed.data.levels ? { levels: JSON.stringify(parsed.data.levels) } : {}),
      updatedAt: new Date(),
    };
    await db.update(schema.benchCriteriaLibrary).set(patch).where(
      and(eq(schema.benchCriteriaLibrary.orgId, user.orgId), eq(schema.benchCriteriaLibrary.id, id)),
    );
    return c.json({ criterion: view({ ...existing, ...patch }) });
  });

  app.delete("/api/criteria/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    // A benchmark that already uses the criterion keeps its own copy in
    // benchmark.yaml; only the library entry goes, and only within the org.
    await db
      .delete(schema.benchCriteriaLibrary)
      .where(and(eq(schema.benchCriteriaLibrary.orgId, user.orgId), eq(schema.benchCriteriaLibrary.id, id)));
    return c.json({ ok: true });
  });

  return app;
}
