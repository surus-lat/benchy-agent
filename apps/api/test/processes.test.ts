import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import { createProcessesApp, type ProcessItem } from "../src/processes";
import type { CurrentUser } from "../src/conversations";
import { HermesError, type HermesClient } from "../src/hermes";

// The /api/processes visibility rules (issue #7): the caller sees their own
// processes and their org's evaluations — never another user's processes and
// never another org's. The container is a fake with canned evaluation states
// per benchmark.

const db = drizzle(env.DB, { schema });

const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const beto: CurrentUser = { id: "user_beto", name: "", email: "beto@uni.edu", orgId: "org_uni" };
const ceci: CurrentUser = { id: "user_ceci", name: "Ceci Sosa", email: "ceci@otra.edu", orgId: "org_otra" };
const orphan: CurrentUser = { id: "user_orphan", name: "", email: "o@x.edu", orgId: null };

const MIN = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);
const epoch = (msAgo: number) => Math.floor((Date.now() - msAgo) / 1000);

/** The container: an evaluation.json per bench; a missing bench reads as null. */
function fakeHermes(states: Record<string, unknown>, opts: { down?: boolean } = {}) {
  const calls: string[] = [];
  const client: HermesClient = {
    async createSession() {
      return "h";
    },
    async chat() {
      return { reply: "", usage: null };
    },
    async listFiles() {
      return { files: [], truncated: false };
    },
    async readFile() {
      return null;
    },
    async validate() {
      return { ok: true };
    },
    async exam() {
      return { ok: true };
    },
    async analysis() {
      return { ok: true };
    },
    async models() {
      return { models: [] };
    },
    async writeFile() {
      return { status: "forbidden" as const };
    },
    async review() {
      return { ok: true };
    },
    async quality() {
      return { ok: true };
    },
    async addSource() {
      throw new HermesError("unused", 500);
    },
    async uploadSource() {
      throw new HermesError("unused", 500);
    },
    async removeSource() {
      return { ok: true };
    },
    async backup() {
      return new ArrayBuffer(0);
    },
    async evaluation(path) {
      const bench = path.split("/")[0];
      calls.push(bench);
      if (opts.down) throw new HermesError("agent unreachable", 502);
      return { ok: true, evaluation: bench in states ? states[bench] : null };
    },
    async startEvaluation() {
      return { status: "refused" as const, body: {} };
    },
    async startReport() {
      return { status: "refused" as const, body: {} };
    },
  };
  return { client, calls };
}

function makeApp(hermes: HermesClient | null, orgsSeen: string[] = []) {
  return createProcessesApp({
    db,
    async currentUser(request) {
      const who = request.headers.get("x-test-user");
      return [ana, beto, ceci, orphan].find((u) => u.id === who) ?? null;
    },
    async agentFor(orgId) {
      orgsSeen.push(orgId);
      return hermes;
    },
  });
}

function get(app: ReturnType<typeof makeApp>, user?: CurrentUser) {
  const headers: Record<string, string> = {};
  if (user) headers["x-test-user"] = user.id;
  return app.request("/api/processes", { headers });
}

async function processes(app: ReturnType<typeof makeApp>, user: CurrentUser): Promise<ProcessItem[]> {
  const res = await get(app, user);
  expect(res.status).toBe(200);
  return ((await res.json()) as { processes: ProcessItem[] }).processes;
}

async function seedActivity(row: {
  orgId: string;
  userId: string;
  who: string;
  bench: string;
  kind: string;
  detail: string;
  createdAt: Date;
}) {
  await db.insert(schema.activity).values({ id: `act_${Math.random().toString(16).slice(2)}`, ...row });
}

async function seedTurn(row: { id: string; userId: string; orgId: string; bench: string | null; turnStartedAt: Date | null }) {
  const now = new Date();
  await db.insert(schema.conversations).values({ hermesSessionId: "h", createdAt: now, updatedAt: now, ...row });
}

beforeEach(async () => {
  await db.delete(schema.activity);
  await db.delete(schema.conversationMessages);
  await db.delete(schema.conversations);
  await db.delete(schema.user);
  await db.delete(schema.orgDomains);
  await db.delete(schema.orgs);
  const now = new Date();
  await db.insert(schema.orgs).values([
    { id: "org_uni", name: "Uni", slug: "uni", createdAt: now },
    { id: "org_otra", name: "Otra", slug: "otra", createdAt: now },
  ]);
  for (const u of [ana, beto, ceci, orphan]) {
    await db.insert(schema.user).values({
      id: u.id,
      name: u.name,
      email: u.email,
      orgId: u.orgId,
      createdAt: now,
      updatedAt: now,
    });
  }
});

it("refuses anonymous callers and users without an org", async () => {
  const app = makeApp(fakeHermes({}).client);
  expect((await get(app)).status).toBe(401);
  expect((await get(app, orphan)).status).toBe(403);
});

it("shows the caller's own turn in flight — and no one else's", async () => {
  await seedTurn({ id: "conv_ana", userId: ana.id, orgId: ana.orgId!, bench: "capitales", turnStartedAt: ago(2 * MIN) });
  await seedTurn({ id: "conv_beto", userId: beto.id, orgId: beto.orgId!, bench: "hidrografia", turnStartedAt: ago(1 * MIN) });
  const app = makeApp(fakeHermes({}).client);

  const anas = await processes(app, ana);
  expect(anas.map((p) => p.id)).toEqual(["turn:conv_ana"]);
  expect(anas[0]).toMatchObject({ type: "agent", status: "running", bench: "capitales", mine: true, who: null });

  const betos = await processes(app, beto);
  expect(betos.map((p) => p.id)).toEqual(["turn:conv_beto"]);
  expect(betos[0]).toMatchObject({ type: "agent", status: "running", bench: "hidrografia" });
});

it("reads a stale turn lock as failed", async () => {
  await seedTurn({ id: "conv_ana", userId: ana.id, orgId: ana.orgId!, bench: "capitales", turnStartedAt: ago(20 * MIN) });
  const list = await processes(makeApp(null), ana);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ type: "agent", status: "failed" });
});

it("shows an org's evaluation to every member, with who started it", async () => {
  await seedActivity({
    orgId: "org_uni",
    userId: ana.id,
    who: ana.name,
    bench: "capitales",
    kind: "evaluate",
    detail: "evaluó 2 modelos",
    createdAt: ago(5 * MIN),
  });
  const app = makeApp(fakeHermes({ capitales: { state: "running", started: epoch(5 * MIN) } }).client);

  const betos = await processes(app, beto);
  expect(betos).toHaveLength(1);
  expect(betos[0]).toMatchObject({
    type: "evaluation",
    status: "running",
    bench: "capitales",
    who: "Ana Pérez",
    mine: false,
    detail: "evaluó 2 modelos",
  });

  const anas = await processes(app, ana);
  expect(anas[0]).toMatchObject({ type: "evaluation", mine: true });
});

it("maps the container's live state to done and failed", async () => {
  await seedActivity({
    orgId: "org_uni",
    userId: ana.id,
    who: ana.name,
    bench: "capitales",
    kind: "evaluate",
    detail: "evaluó 1 modelo",
    createdAt: ago(60 * MIN),
  });
  await seedActivity({
    orgId: "org_uni",
    userId: ana.id,
    who: ana.name,
    bench: "hidrografia",
    kind: "evaluate",
    detail: "evaluó 1 modelo",
    createdAt: ago(30 * MIN),
  });
  const app = makeApp(
    fakeHermes({
      capitales: { state: "done", started: epoch(60 * MIN), finished: epoch(50 * MIN) },
      hidrografia: { state: "interrupted", started: epoch(30 * MIN), finished: epoch(29 * MIN) },
    }).client,
  );
  const list = await processes(app, beto);
  expect(list).toHaveLength(2);
  expect(list.find((p) => p.bench === "capitales")).toMatchObject({ status: "done", finishedAt: expect.any(String) });
  expect(list.find((p) => p.bench === "hidrografia")).toMatchObject({ status: "failed" });
  // Both finished: newest first.
  expect(list[0].bench).toBe("hidrografia");
});

it("never leaks across orgs: evaluations and turns stay inside the caller's org", async () => {
  await seedActivity({
    orgId: "org_uni",
    userId: ana.id,
    who: ana.name,
    bench: "capitales",
    kind: "evaluate",
    detail: "evaluó 1 modelo",
    createdAt: ago(5 * MIN),
  });
  await seedActivity({
    orgId: "org_otra",
    userId: ceci.id,
    who: ceci.name,
    bench: "mineria",
    kind: "evaluate",
    detail: "evaluó 2 modelos",
    createdAt: ago(5 * MIN),
  });
  await seedTurn({ id: "conv_ana", userId: ana.id, orgId: ana.orgId!, bench: "capitales", turnStartedAt: ago(1 * MIN) });
  await seedTurn({ id: "conv_ceci", userId: ceci.id, orgId: ceci.orgId!, bench: "mineria", turnStartedAt: ago(1 * MIN) });
  const { client, calls } = fakeHermes({
    capitales: { state: "running", started: epoch(5 * MIN) },
    mineria: { state: "running", started: epoch(5 * MIN) },
  });
  const orgsSeen: string[] = [];
  const app = makeApp(client, orgsSeen);

  // Ana (org_uni): her own turn + her org's evaluation — nothing of Ceci's.
  const anas = await processes(app, ana);
  expect(new Set(anas.map((p) => p.id))).toEqual(new Set(["turn:conv_ana", "evaluate:capitales"]));
  expect(anas.some((p) => p.who === ceci.name)).toBe(false);

  // Ceci (org_otra): her own turn + her org's evaluation — nothing of Ana's.
  const cecis = await processes(app, ceci);
  expect(new Set(cecis.map((p) => p.id))).toEqual(new Set(["turn:conv_ceci", "evaluate:mineria"]));
  expect(cecis.some((p) => p.who === ana.name)).toBe(false);

  // And each caller's live state came from their own org's container only.
  expect(orgsSeen).toEqual(["org_uni", "org_otra"]);
  expect([...calls].sort()).toEqual(["capitales", "mineria"]);
});

it("keeps a fresh start event as running when the container is unreachable, and forgets an old one", async () => {
  await seedActivity({
    orgId: "org_uni",
    userId: ana.id,
    who: ana.name,
    bench: "capitales",
    kind: "evaluate",
    detail: "evaluó 1 modelo",
    createdAt: ago(2 * MIN),
  });
  await seedActivity({
    orgId: "org_uni",
    userId: ana.id,
    who: ana.name,
    bench: "viejo",
    kind: "evaluate",
    detail: "evaluó 1 modelo",
    createdAt: ago(2 * 60 * MIN),
  });

  const down = await processes(makeApp(fakeHermes({}, { down: true }).client), ana);
  expect(down.map((p) => p.id)).toEqual(["evaluate:capitales"]);
  expect(down[0].status).toBe("running");

  // No container provisioned at all: same fallback.
  const none = await processes(makeApp(null), ana);
  expect(none.map((p) => p.id)).toEqual(["evaluate:capitales"]);
});

it("shows report generation as its own process type", async () => {
  await seedActivity({
    orgId: "org_uni",
    userId: ana.id,
    who: ana.name,
    bench: "capitales",
    kind: "report",
    detail: "generó el informe",
    createdAt: ago(3 * MIN),
  });
  const app = makeApp(fakeHermes({ capitales: { state: "reporting", started: epoch(3 * MIN) } }).client);
  const list = await processes(app, beto);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ type: "report", status: "running", bench: "capitales" });
});
