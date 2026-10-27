import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import type { CurrentUser } from "./conversations";

type Db = DrizzleD1Database<typeof schema>;

/** Only users in this org can access /api/admin/*. */
export const ADMIN_ORG_ID = "org_4eb2a44fdc5ef17b";

export type AdminDeps = {
  db: Db;
  currentUser: (request: Request) => Promise<CurrentUser | null>;
};

function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const createOrgSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9-]+$/),
});

const updateOrgSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  brandColorSecondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  brandTagline: z.string().trim().max(120).nullable().optional(),
  brandLogoUrl: z.string().regex(/^https?:\/\//).max(2048).nullable().optional(),
});

const addDomainSchema = z.object({
  domain: z.string().trim().min(1).max(253).transform((d) => d.toLowerCase()),
});

const setEndpointSchema = z.object({
  baseUrl: z.string().trim().url().max(500),
  apiKeyRef: z.string().trim().min(1).max(100),
});

const createInviteSchema = z.object({
  orgId: z.string().trim().min(1),
  email: z.string().trim().email().max(320),
  expiresInDays: z.number().int().min(1).max(90).default(7),
});

const updateAccessRequestSchema = z.object({
  status: z.enum(["invited", "declined"]),
});

export function createAdminApp(deps: AdminDeps) {
  const { db } = deps;
  const app = new Hono<{ Variables: { user: CurrentUser & { orgId: string } } }>();

  // Auth gate: only surus org users can access admin routes
  app.use("/api/admin/*", async (c, next) => {
    const user = await deps.currentUser(c.req.raw);
    if (!user) return c.json({ error: "UNAUTHENTICATED" }, 401);
    if (!user.orgId || user.orgId !== ADMIN_ORG_ID) return c.json({ error: "FORBIDDEN" }, 403);
    c.set("user", user as CurrentUser & { orgId: string });
    await next();
  });

  // ---- Organizations --------------------------------------------------------

  // GET /api/admin/orgs — list all orgs with domains, endpoint, user count
  app.get("/api/admin/orgs", async (c) => {
    const orgs = await db.select().from(schema.orgs).orderBy(desc(schema.orgs.createdAt));

    const domains = await db.select().from(schema.orgDomains);
    const endpoints = await db.select().from(schema.orgAgentEndpoints);
    const userCounts = await db
      .select({ orgId: schema.user.orgId, count: sql<number>`count(*)` })
      .from(schema.user)
      .groupBy(schema.user.orgId);

    const domainsByOrg = new Map<string, string[]>();
    for (const d of domains) {
      const list = domainsByOrg.get(d.orgId) ?? [];
      list.push(d.domain);
      domainsByOrg.set(d.orgId, list);
    }

    const endpointByOrg = new Map(endpoints.map((e) => [e.orgId, e]));
    const countByOrg = new Map(userCounts.map((u) => [u.orgId, u.count]));

    return c.json({
      orgs: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        brandColor: o.brandColor,
        brandColorSecondary: o.brandColorSecondary,
        brandTagline: o.brandTagline,
        brandLogoUrl: o.brandLogoUrl,
        createdAt: o.createdAt,
        domains: domainsByOrg.get(o.id) ?? [],
        endpoint: endpointByOrg.has(o.id)
          ? { baseUrl: endpointByOrg.get(o.id)!.baseUrl, apiKeyRef: endpointByOrg.get(o.id)!.apiKeyRef }
          : null,
        userCount: countByOrg.get(o.id) ?? 0,
      })),
    });
  });

  // POST /api/admin/orgs — create a new org
  app.post("/api/admin/orgs", async (c) => {
    const parsed = createOrgSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY", fields: parsed.error.issues }, 400);
    const id = newId("org_");
    const now = new Date();
    await db.insert(schema.orgs).values({
      id,
      name: parsed.data.name,
      slug: parsed.data.slug,
      createdAt: now,
    });
    return c.json({ id, name: parsed.data.name, slug: parsed.data.slug, createdAt: now }, 201);
  });

  // PATCH /api/admin/orgs/:id — update org
  app.patch("/api/admin/orgs/:id", async (c) => {
    const orgId = c.req.param("id");
    const parsed = updateOrgSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY", fields: parsed.error.issues }, 400);
    const updates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.slug !== undefined) updates.slug = parsed.data.slug;
    if (parsed.data.brandColor !== undefined) updates.brandColor = parsed.data.brandColor;
    if (parsed.data.brandColorSecondary !== undefined) updates.brandColorSecondary = parsed.data.brandColorSecondary;
    if (parsed.data.brandTagline !== undefined) updates.brandTagline = parsed.data.brandTagline;
    if (parsed.data.brandLogoUrl !== undefined) updates.brandLogoUrl = parsed.data.brandLogoUrl;
    if (Object.keys(updates).length === 0) return c.json({ error: "NOTHING_TO_UPDATE" }, 400);
    const updated = await db
      .update(schema.orgs)
      .set(updates)
      .where(eq(schema.orgs.id, orgId))
      .returning({ id: schema.orgs.id });
    if (updated.length === 0) return c.json({ error: "NOT_FOUND" }, 404);
    return c.json({ ok: true });
  });

  // ---- Domains ---------------------------------------------------------------

  // GET /api/admin/orgs/:id/domains
  app.get("/api/admin/orgs/:id/domains", async (c) => {
    const orgId = c.req.param("id");
    const rows = await db
      .select()
      .from(schema.orgDomains)
      .where(eq(schema.orgDomains.orgId, orgId));
    return c.json({ domains: rows.map((d) => ({ domain: d.domain, createdAt: d.createdAt })) });
  });

  // POST /api/admin/orgs/:id/domains — add a domain
  app.post("/api/admin/orgs/:id/domains", async (c) => {
    const orgId = c.req.param("id");
    const parsed = addDomainSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const now = new Date();
    await db
      .insert(schema.orgDomains)
      .values({ domain: parsed.data.domain, orgId, createdAt: now })
      .onConflictDoNothing();
    return c.json({ domain: parsed.data.domain, createdAt: now }, 201);
  });

  // DELETE /api/admin/orgs/:id/domains/:domain
  app.delete("/api/admin/orgs/:id/domains/:domain", async (c) => {
    const orgId = c.req.param("id");
    const domain = c.req.param("domain");
    const deleted = await db
      .delete(schema.orgDomains)
      .where(and(eq(schema.orgDomains.orgId, orgId), eq(schema.orgDomains.domain, domain)))
      .returning({ domain: schema.orgDomains.domain });
    if (deleted.length === 0) return c.json({ error: "NOT_FOUND" }, 404);
    return c.json({ ok: true });
  });

  // ---- Agent Endpoint --------------------------------------------------------

  // GET /api/admin/orgs/:id/endpoint
  app.get("/api/admin/orgs/:id/endpoint", async (c) => {
    const orgId = c.req.param("id");
    const [row] = await db
      .select()
      .from(schema.orgAgentEndpoints)
      .where(eq(schema.orgAgentEndpoints.orgId, orgId))
      .limit(1);
    return row
      ? c.json({ endpoint: { baseUrl: row.baseUrl, apiKeyRef: row.apiKeyRef, createdAt: row.createdAt } })
      : c.json({ endpoint: null });
  });

  // PUT /api/admin/orgs/:id/endpoint
  app.put("/api/admin/orgs/:id/endpoint", async (c) => {
    const orgId = c.req.param("id");
    const parsed = setEndpointSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const now = new Date();
    await db
      .insert(schema.orgAgentEndpoints)
      .values({ orgId, baseUrl: parsed.data.baseUrl, apiKeyRef: parsed.data.apiKeyRef, createdAt: now })
      .onConflictDoUpdate({
        target: schema.orgAgentEndpoints.orgId,
        set: { baseUrl: parsed.data.baseUrl, apiKeyRef: parsed.data.apiKeyRef },
      });
    return c.json({ ok: true });
  });

  // ---- Users -----------------------------------------------------------------

  // GET /api/admin/users — list all users with their org
  app.get("/api/admin/users", async (c) => {
    const users = await db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        orgId: schema.user.orgId,
        createdAt: schema.user.createdAt,
      })
      .from(schema.user)
      .orderBy(desc(schema.user.createdAt));

    const orgs = await db.select({ id: schema.orgs.id, name: schema.orgs.name }).from(schema.orgs);
    const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

    return c.json({
      users: users.map((u) => ({
        ...u,
        orgName: u.orgId ? orgMap.get(u.orgId) ?? null : null,
      })),
    });
  });

  // ---- Invites ---------------------------------------------------------------

  // GET /api/admin/invites — list all invites
  app.get("/api/admin/invites", async (c) => {
    const rows = await db
      .select({
        id: schema.invites.id,
        orgId: schema.invites.orgId,
        email: schema.invites.email,
        status: schema.invites.status,
        createdAt: schema.invites.createdAt,
        expiresAt: schema.invites.expiresAt,
      })
      .from(schema.invites)
      .orderBy(desc(schema.invites.createdAt));

    const orgs = await db.select({ id: schema.orgs.id, name: schema.orgs.name }).from(schema.orgs);
    const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

    return c.json({
      invites: rows.map((i) => ({
        ...i,
        orgName: orgMap.get(i.orgId) ?? null,
      })),
    });
  });

  // POST /api/admin/invites — create an invite
  app.post("/api/admin/invites", async (c) => {
    const parsed = createInviteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY", fields: parsed.error.issues }, 400);
    const id = newId("inv_");
    const token = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000);
    await db.insert(schema.invites).values({
      id,
      orgId: parsed.data.orgId,
      email: parsed.data.email.toLowerCase(),
      token,
      status: "pending",
      createdAt: now,
      expiresAt,
    });
    return c.json({ id, email: parsed.data.email.toLowerCase(), token, expiresAt }, 201);
  });

  // ---- Access Requests -------------------------------------------------------

  // GET /api/admin/access-requests
  app.get("/api/admin/access-requests", async (c) => {
    const rows = await db
      .select()
      .from(schema.accessRequests)
      .orderBy(desc(schema.accessRequests.createdAt));
    return c.json({ accessRequests: rows });
  });

  // PATCH /api/admin/access-requests/:id
  app.patch("/api/admin/access-requests/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = updateAccessRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    const updated = await db
      .update(schema.accessRequests)
      .set({ status: parsed.data.status })
      .where(eq(schema.accessRequests.id, id))
      .returning({ id: schema.accessRequests.id });
    if (updated.length === 0) return c.json({ error: "NOT_FOUND" }, 404);
    return c.json({ ok: true });
  });

  // ---- Activity --------------------------------------------------------------

  // GET /api/admin/activity — recent activity across all orgs
  app.get("/api/admin/activity", async (c) => {
    const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 500);
    const rows = await db
      .select({
        id: schema.activity.id,
        orgId: schema.activity.orgId,
        who: schema.activity.who,
        userId: schema.activity.userId,
        bench: schema.activity.bench,
        kind: schema.activity.kind,
        detail: schema.activity.detail,
        createdAt: schema.activity.createdAt,
      })
      .from(schema.activity)
      .orderBy(desc(schema.activity.createdAt))
      .limit(limit);

    const orgs = await db.select({ id: schema.orgs.id, name: schema.orgs.name }).from(schema.orgs);
    const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

    return c.json({
      activity: rows.map((a) => ({
        ...a,
        orgName: orgMap.get(a.orgId) ?? null,
      })),
    });
  });

  return app;
}
