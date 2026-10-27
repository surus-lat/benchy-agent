import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { createConversationsApp, type CurrentUser } from "../src/conversations";
import type { HermesClient, Source } from "../src/hermes";
import type { Paper } from "../src/library";

// The org's checklist for validating new material (sourceChecklistItems) and
// one benchmark source's state against it (sourceValidations): material added
// from the platform starts pending and is validated when every item of the
// org's checklist is ticked; material from before this feature has no row and
// counts as validated (grandfathered). Editing the checklist never revalidates
// what already passed. Hermes is a fake whose adds succeed.

const db = drizzle(env.DB, { schema });

const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const ceci: CurrentUser = { id: "user_ceci", name: "Ceci Ruiz", email: "ceci@otra.edu", orgId: "org_otra" };
const orphan: CurrentUser = { id: "user_orphan", name: "", email: "o@x.edu", orgId: null };

const PAPER: Paper = {
  id: 42,
  origin: "conicet",
  title: "Un paper",
  creators: ["Pérez, Juan"],
  subjects: [],
  description: "",
  date: "2020",
  year: 2020,
  type: "article",
  language: "spa",
  publisher: "",
  rights: "",
  pdfUrl: "https://x/pdf",
  url: "https://x",
};

function source(id: string): Source {
  return {
    id,
    origin: id.startsWith("pdf-") ? "upload" : "conicet",
    title: `Paper ${id}`,
    authors: ["Pérez, Juan"],
    year: 2020,
    url: "https://x",
    pdf_url: "https://x/pdf",
    file: `${id}.md`,
    pages: 10,
    chars: 5000,
    text: "full",
    added: 1_700_000_000,
  };
}

function fakeHermes(): { client: HermesClient; added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const client: HermesClient = {
    async createSession() {
      return "hermes_1";
    },
    async chat() {
      return { reply: "ok", usage: {} };
    },
    async listFiles() {
      return { files: [], truncated: false };
    },
    async validate(path) {
      return { ok: true, path };
    },
    async exam(path) {
      return { ok: true, total: 0, rows: [] };
    },
    async analysis(path) {
      return { ok: true, models: [], questions: [] };
    },
    async models() {
      return { provider: "bedrock", models: [] };
    },
    async writeFile(path) {
      return { status: "ok", path, modified: 1 };
    },
    async review() {
      return { ok: true, rows: [] };
    },
    async quality() {
      return { ok: true, rows: [] };
    },
    async addSource(bench, paper) {
      const id = `${paper.origin}-${paper.id}`;
      added.push(id);
      return { ok: true, source: source(id) };
    },
    async uploadSource(bench, name) {
      added.push("pdf-9f8e7d");
      return { ok: true, source: source("pdf-9f8e7d") };
    },
    async removeSource(bench, id) {
      removed.push(id);
      return { ok: true };
    },
    async backup() {
      return new ArrayBuffer(0);
    },
    async evaluation(path) {
      return { ok: true, evaluation: null, path };
    },
    async startEvaluation() {
      return { status: "started", body: { ok: true } };
    },
    async startReport() {
      return { status: "started", body: { ok: true } };
    },
    async readFile() {
      return null;
    },
  };
  return { client, added, removed };
}

function makeApp(hermes: HermesClient | null) {
  return createConversationsApp({
    db,
    async currentUser(request) {
      const who = request.headers.get("x-test-user");
      return [ana, ceci, orphan].find((u) => u.id === who) ?? null;
    },
    async agentFor() {
      return hermes;
    },
    async paper(id) {
      return id === 42 ? PAPER : null;
    },
  });
}

function req(app: ReturnType<typeof makeApp>, method: string, path: string, user?: CurrentUser, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user.id;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

type Item = { id: string; label: string };
type Validation = { sourceId: string; checked: string[]; validatedAt: string | null; validatedByName: string | null };

const DEFAULT_IDS = ["respaldo", "formato", "trazabilidad"];

async function checklist(app: ReturnType<typeof makeApp>, user: CurrentUser): Promise<Item[]> {
  const res = await req(app, "GET", "/api/org/source-checklist", user);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Item[] }).items;
}

async function validations(app: ReturnType<typeof makeApp>, user: CurrentUser, bench: string): Promise<Validation[]> {
  const res = await req(app, "GET", `/api/workspace/sources/validation?bench=${bench}`, user);
  expect(res.status).toBe(200);
  return ((await res.json()) as { validations: Validation[] }).validations;
}

async function tick(
  app: ReturnType<typeof makeApp>,
  user: CurrentUser,
  bench: string,
  sourceId: string,
  checked: string[],
): Promise<Validation> {
  const res = await req(app, "PUT", "/api/workspace/sources/validation", user, { bench, sourceId, checked });
  expect(res.status).toBe(200);
  return ((await res.json()) as { validation: Validation }).validation;
}

beforeEach(async () => {
  // Adding or removing a source logs activity rows that point at the org.
  await db.delete(schema.activity);
  await db.delete(schema.sourceChecklistItems);
  await db.delete(schema.sourceValidations);
  await db.delete(schema.user);
  await db.delete(schema.orgDomains);
  await db.delete(schema.orgs);
  const now = new Date();
  await db.insert(schema.orgs).values([
    { id: "org_uni", name: "Uni", slug: "uni", createdAt: now },
    { id: "org_otra", name: "Otra", slug: "otra", createdAt: now },
  ]);
  for (const u of [ana, ceci, orphan]) {
    await db.insert(schema.user).values({ id: u.id, name: u.name, email: u.email, orgId: u.orgId, createdAt: now, updatedAt: now });
  }
});

it("requires auth and input with a valid shape", async () => {
  const app = makeApp(fakeHermes().client);
  for (const [method, path] of [
    ["GET", "/api/org/source-checklist"],
    ["PUT", "/api/org/source-checklist"],
    ["GET", "/api/workspace/sources/validation?bench=qa"],
    ["PUT", "/api/workspace/sources/validation"],
  ] as const) {
    expect((await req(app, method, path)).status).toBe(401);
    expect((await req(app, method, path, orphan)).status).toBe(403);
  }

  expect((await req(app, "GET", "/api/workspace/sources/validation", ana)).status).toBe(400);
  expect((await req(app, "GET", "/api/workspace/sources/validation?bench=../etc", ana)).status).toBe(400);
  expect((await req(app, "PUT", "/api/workspace/sources/validation", ana, { bench: "a/b", sourceId: "pdf-1", checked: [] })).status).toBe(400);
  expect((await req(app, "PUT", "/api/workspace/sources/validation", ana, { bench: "qa", sourceId: "PDF-1", checked: [] })).status).toBe(400);
  expect((await req(app, "PUT", "/api/workspace/sources/validation", ana, { bench: "qa", sourceId: "pdf-1" })).status).toBe(400);
  expect((await req(app, "PUT", "/api/workspace/sources/validation", ana, { bench: "qa", sourceId: "pdf-1", checked: ["¿?"] })).status).toBe(400);

  expect((await req(app, "PUT", "/api/org/source-checklist", ana, {})).status).toBe(400);
  expect((await req(app, "PUT", "/api/org/source-checklist", ana, { items: [] })).status).toBe(400);
  expect((await req(app, "PUT", "/api/org/source-checklist", ana, { items: [{ label: "  " }] })).status).toBe(400);
  expect((await req(app, "PUT", "/api/org/source-checklist", ana, { items: [{ label: "x".repeat(201) }] })).status).toBe(400);
  expect(
    (await req(app, "PUT", "/api/org/source-checklist", ana, { items: Array.from({ length: 21 }, (_, i) => ({ label: `ítem ${i}` })) })).status,
  ).toBe(400);
  expect(
    (await req(app, "PUT", "/api/org/source-checklist", ana, { items: [{ id: "a", label: "uno" }, { id: "a", label: "otro" }] })).status,
  ).toBe(400);
  expect((await req(app, "PUT", "/api/org/source-checklist", ana, { items: [{ id: "¿?", label: "uno" }] })).status).toBe(400);
});

it("seeds each org's checklist with the placeholder items and persists its edits", async () => {
  const app = makeApp(fakeHermes().client);

  // First read materializes the placeholder checklist (the issue's three
  // examples), in order, keyed to the org.
  const items = await checklist(app, ana);
  expect(items.map((i) => i.id)).toEqual(DEFAULT_IDS);
  expect(items.map((i) => i.label)).toEqual([
    "Respaldo editorial o institucional",
    "Formato legible: PDF con texto seleccionable",
    "Trazabilidad de la fuente: autoría, año y procedencia identificables",
  ]);
  expect(await db.select().from(schema.sourceChecklistItems).where(eq(schema.sourceChecklistItems.orgId, "org_uni"))).toHaveLength(3);

  // Reading again does not duplicate rows.
  await checklist(app, ana);
  expect(await db.select().from(schema.sourceChecklistItems).where(eq(schema.sourceChecklistItems.orgId, "org_uni"))).toHaveLength(3);

  // Replacing: rename an item keeping its id, drop one, add a new one.
  const put = await req(app, "PUT", "/api/org/source-checklist", ana, {
    items: [
      { id: "respaldo", label: "Respaldo institucional verificable" },
      { label: "Fecha de publicación visible" },
      { id: "trazabilidad", label: "Trazabilidad de la fuente: autoría, año y procedencia identificables" },
    ],
  });
  expect(put.status).toBe(200);
  const edited = ((await put.json()) as { items: Item[] }).items;
  expect(edited).toHaveLength(3);
  expect(edited[0]).toEqual({ id: "respaldo", label: "Respaldo institucional verificable" });
  expect(edited[1].id).toMatch(/^it-[0-9a-f]{20}$/);
  expect(edited[2].id).toBe("trazabilidad");
  expect((await checklist(app, ana)).map((i) => i.id)).toEqual(edited.map((i) => i.id));
  const rows = await db.select().from(schema.sourceChecklistItems).where(eq(schema.sourceChecklistItems.orgId, "org_uni"));
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.position).sort()).toEqual([0, 1, 2]);

  // Another org keeps its own checklist: it never sees Ana's edit.
  expect((await checklist(app, ceci)).map((i) => i.id)).toEqual(DEFAULT_IDS);
  expect(await db.select().from(schema.sourceChecklistItems).where(eq(schema.sourceChecklistItems.orgId, "org_otra"))).toHaveLength(3);
});

it("starts platform-added material pending and validates it when the checklist is fully ticked", async () => {
  const hermes = fakeHermes();
  const app = makeApp(hermes.client);

  // Adding a library paper to the bench records its validation row as pending.
  const add = await req(app, "POST", "/api/workspace/sources", ana, { bench: "qa", paperId: 42 });
  expect(add.status).toBe(200);
  expect(hermes.added).toEqual(["conicet-42"]);
  const pending = await validations(app, ana, "qa");
  expect(pending).toEqual([{ sourceId: "conicet-42", checked: [], validatedAt: null, validatedByName: null }]);

  // Ticking one item of three: still pending.
  const partial = await tick(app, ana, "qa", "conicet-42", ["respaldo"]);
  expect(partial).toMatchObject({ checked: ["respaldo"], validatedAt: null });

  // Ticking every item of the current checklist: validated, with who and when.
  const done = await tick(app, ana, "qa", "conicet-42", ["respaldo", "formato", "trazabilidad"]);
  expect(done.checked).toHaveLength(3);
  expect(done.validatedAt).not.toBeNull();
  expect(done.validatedByName).toBe("Ana Pérez");
  const [row] = await db.select().from(schema.sourceValidations);
  expect(row).toMatchObject({ orgId: "org_uni", bench: "qa", sourceId: "conicet-42", validatedBy: "user_ana" });
  expect((await validations(app, ana, "qa"))[0].validatedAt).not.toBeNull();
});

it("marks uploaded material pending too", async () => {
  const app = makeApp(fakeHermes().client);
  const pdf = new TextEncoder().encode("%PDF-1.7 fake");
  const res = await app.request("/api/workspace/sources/upload?bench=qa&name=apunte.pdf", {
    method: "POST",
    headers: { "x-test-user": ana.id, "content-type": "application/pdf" },
    body: pdf,
  });
  expect(res.status).toBe(200);
  expect(await validations(app, ana, "qa")).toEqual([{ sourceId: "pdf-9f8e7d", checked: [], validatedAt: null, validatedByName: null }]);
});

it("treats material with no row as validated (grandfathered) and never revalidates what passed", async () => {
  const app = makeApp(fakeHermes().client);

  // A bench whose sources predate this feature has no rows at all: the app
  // shows every row-less source as validated.
  expect(await validations(app, ana, "qa")).toEqual([]);

  // A source validated under one checklist stays validated when the checklist
  // grows: the new item does not revalidate it retroactively.
  await req(app, "POST", "/api/workspace/sources", ana, { bench: "qa", paperId: 42 });
  await tick(app, ana, "qa", "conicet-42", DEFAULT_IDS);
  expect((await validations(app, ana, "qa"))[0].validatedAt).not.toBeNull();
  await req(app, "PUT", "/api/org/source-checklist", ana, {
    items: [...DEFAULT_IDS.map((id) => ({ id, label: id })), { label: "Un requisito nuevo" }],
  });
  expect((await validations(app, ana, "qa"))[0].validatedAt).not.toBeNull();

  // Unticking afterwards does not take the validation back either.
  const after = await tick(app, ana, "qa", "conicet-42", []);
  expect(after.checked).toEqual([]);
  expect(after.validatedAt).not.toBeNull();
  expect(after.validatedByName).toBe("Ana Pérez");
});

it("keeps each org's validations its own: another org never reads or writes them", async () => {
  const app = makeApp(fakeHermes().client);

  await req(app, "POST", "/api/workspace/sources", ana, { bench: "qa", paperId: 42 });
  await tick(app, ana, "qa", "conicet-42", DEFAULT_IDS);

  // Same bench name in Ceci's org: no rows, nothing of Ana's leaks.
  expect(await validations(app, ceci, "qa")).toEqual([]);

  // Her own validation lives beside Ana's, each keyed to its org.
  await tick(app, ceci, "qa", "conicet-42", DEFAULT_IDS);
  const rows = await db.select().from(schema.sourceValidations);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((r) => r.orgId))).toEqual(new Set(["org_uni", "org_otra"]));
  expect(rows.find((r) => r.orgId === "org_otra")).toMatchObject({ validatedBy: "user_ceci", validatedByName: "Ceci Ruiz" });
  expect(rows.find((r) => r.orgId === "org_uni")).toMatchObject({ validatedBy: "user_ana" });
});

it("forgets the validation when the source is removed, and starts it over if re-added", async () => {
  const hermes = fakeHermes();
  const app = makeApp(hermes.client);

  await req(app, "POST", "/api/workspace/sources", ana, { bench: "qa", paperId: 42 });
  await tick(app, ana, "qa", "conicet-42", DEFAULT_IDS);
  expect(await validations(app, ana, "qa")).toHaveLength(1);

  const del = await req(app, "DELETE", "/api/workspace/sources?bench=qa&id=conicet-42", ana);
  expect(del.status).toBe(200);
  expect(hermes.removed).toEqual(["conicet-42"]);
  expect(await validations(app, ana, "qa")).toEqual([]);
  expect(await db.select().from(schema.sourceValidations)).toHaveLength(0);

  // Re-adding the same paper is new material: pending again.
  await req(app, "POST", "/api/workspace/sources", ana, { bench: "qa", paperId: 42 });
  expect(await validations(app, ana, "qa")).toEqual([{ sourceId: "conicet-42", checked: [], validatedAt: null, validatedByName: null }]);
});

it("ignores ticked items that are not in the checklist", async () => {
  const app = makeApp(fakeHermes().client);
  await req(app, "POST", "/api/workspace/sources", ana, { bench: "qa", paperId: 42 });

  // A made-up id is dropped and never counts towards completion.
  const v = await tick(app, ana, "qa", "conicet-42", ["respaldo", "respaldo", "inventado"]);
  expect(v.checked).toEqual(["respaldo"]);
  expect(v.validatedAt).toBeNull();

  // And after the org edits its checklist, an id it no longer has is dropped.
  await req(app, "PUT", "/api/org/source-checklist", ana, { items: [{ label: "Lo único que importa" }] });
  const only = ((await checklist(app, ana))[0] as Item).id;
  const done = await tick(app, ana, "qa", "conicet-42", ["respaldo", only]);
  expect(done.checked).toEqual([only]);
  expect(done.validatedAt).not.toBeNull();
});
