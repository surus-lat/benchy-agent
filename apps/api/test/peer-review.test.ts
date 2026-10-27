import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { createPeerReviewApp, type PeerReviewDeps } from "../src/peer-review";
import { HermesError, type HermesClient } from "../src/hermes";
import type { CurrentUser } from "../src/conversations";

// Peer review of questions inside the org (issue #1): GET /api/org/questions
// lists every question of the org's benchmarks with its vote tally;
// POST /api/org/questions/vote records +1/-1/0 per member. Votes are keyed by
// (bench, q, member) and carry the sha256 of the trimmed question text: when
// the text changes, the stored votes no longer match and are hidden. Org A
// never sees or changes org B's votes.

const db = drizzle(env.DB, { schema });

const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const ana2: CurrentUser = { id: "user_ana2", name: "Ana Segunda", email: "ana2@uni.edu", orgId: "org_uni" };
const ceci: CurrentUser = { id: "user_ceci", name: "Ceci Ruiz", email: "ceci@otra.edu", orgId: "org_otra" };
const orphan: CurrentUser = { id: "user_orphan", name: "", email: "o@x.edu", orgId: null };

type ExamRow = { line: number; input: unknown; expected: unknown; status: string; error: null };

function examRows(question: string, answer = "La respuesta experta."): ExamRow[] {
  return [
    { line: 1, input: question, expected: answer, status: "valid", error: null },
    { line: 2, input: "Segunda pregunta", expected: "Otra respuesta.", status: "valid", error: null },
  ];
}

function fakeHermes(opts: { benches?: string[]; questions?: Record<string, string>; brokenBench?: string } = {}): HermesClient {
  const benches = opts.benches ?? ["qa"];
  return {
    async listFiles() {
      const files = benches.flatMap((b) => [
        { path: `${b}/benchmark.yaml`, size: 10, modified: 1 },
        { path: `${b}/exam.jsonl`, size: 20, modified: 1 },
      ]);
      return { files, truncated: false };
    },
    async exam(path) {
      const bench = path.split("/")[0];
      if (bench === opts.brokenBench) throw new HermesError("agent returned 500", 502);
      const question = opts.questions?.[bench] ?? "¿Cuál es la capital de Francia?";
      return { ok: true, total: 2, valid: 2, rejected: 0, truncated: false, rows: examRows(question), dimensions: [] };
    },
  } as unknown as HermesClient;
}

function makeApp(hermes: HermesClient | null) {
  const deps: PeerReviewDeps = {
    db,
    async currentUser(request) {
      const who = request.headers.get("x-test-user");
      return [ana, ana2, ceci, orphan].find((u) => u.id === who) ?? null;
    },
    async agentFor() {
      return hermes;
    },
  };
  return createPeerReviewApp(deps);
}

function req(app: ReturnType<typeof makeApp>, method: string, path: string, user?: CurrentUser, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user.id;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function hashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.trim()));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type QuestionOut = {
  bench: string;
  q: number;
  question: string;
  expectedAnswer: string | null;
  votes: { up: number; down: number };
  myVote: number | null;
  hash: string;
  validated: boolean;
};

async function listQuestions(app: ReturnType<typeof makeApp>, user: CurrentUser): Promise<QuestionOut[]> {
  const res = await req(app, "GET", "/api/org/questions", user);
  expect(res.status).toBe(200);
  return ((await res.json()) as { questions: QuestionOut[] }).questions;
}

beforeEach(async () => {
  await db.delete(schema.questionValidations);
  await db.delete(schema.activity);
  await db.delete(schema.user);
  await db.delete(schema.orgDomains);
  await db.delete(schema.orgs);
  const now = new Date();
  await db.insert(schema.orgs).values([
    { id: "org_uni", name: "Uni", slug: "uni", createdAt: now },
    { id: "org_otra", name: "Otra", slug: "otra", createdAt: now },
  ]);
  for (const u of [ana, ana2, ceci, orphan]) {
    await db.insert(schema.user).values({ id: u.id, name: u.name, email: u.email, orgId: u.orgId, createdAt: now, updatedAt: now });
  }
});

it("requires auth and an org", async () => {
  const app = makeApp(fakeHermes());
  expect((await req(app, "GET", "/api/org/questions")).status).toBe(401);
  expect((await req(app, "POST", "/api/org/questions/vote", undefined, { bench: "qa", q: 1, hash: "a".repeat(64), vote: 1 })).status).toBe(401);
  expect((await req(app, "GET", "/api/org/questions", orphan)).status).toBe(403);
  expect((await req(app, "POST", "/api/org/questions/vote", orphan, { bench: "qa", q: 1, hash: "a".repeat(64), vote: 1 })).status).toBe(403);
});

it("answers 503 when the org has no agent yet", async () => {
  expect((await req(makeApp(null), "GET", "/api/org/questions", ana)).status).toBe(503);
});

it("lists the org's questions across benches with empty tallies", async () => {
  const app = makeApp(fakeHermes({ benches: ["qa", "historia"] }));
  const qs = await listQuestions(app, ana);
  expect(qs.map((x) => `${x.bench}#${x.q}`)).toEqual(["historia#1", "historia#2", "qa#1", "qa#2"]);
  const first = qs.find((x) => x.bench === "qa" && x.q === 1)!;
  expect(first.question).toBe("¿Cuál es la capital de Francia?");
  expect(first.expectedAnswer).toBe("La respuesta experta.");
  expect(first.hash).toBe(await hashOf("¿Cuál es la capital de Francia?"));
  expect(first.votes).toEqual({ up: 0, down: 0 });
  expect(first.myVote).toBeNull();
  expect(first.validated).toBe(false);
});

it("upserts a member's vote: up then down replaces it", async () => {
  const app = makeApp(fakeHermes());
  const hash = await hashOf("¿Cuál es la capital de Francia?");
  expect((await req(app, "POST", "/api/org/questions/vote", ana, { bench: "qa", q: 1, hash, vote: 1 })).status).toBe(200);
  expect((await req(app, "POST", "/api/org/questions/vote", ana, { bench: "qa", q: 1, hash, vote: -1 })).status).toBe(200);
  const qs = await listQuestions(app, ana);
  const first = qs.find((x) => x.bench === "qa" && x.q === 1)!;
  expect(first.votes).toEqual({ up: 0, down: 1 });
  expect(first.myVote).toBe(-1);
  // One row per member, not two.
  expect((await db.select().from(schema.questionValidations)).length).toBe(1);
});

it("vote 0 clears the member's vote", async () => {
  const app = makeApp(fakeHermes());
  const hash = await hashOf("¿Cuál es la capital de Francia?");
  await req(app, "POST", "/api/org/questions/vote", ana, { bench: "qa", q: 1, hash, vote: 1 });
  expect((await req(app, "POST", "/api/org/questions/vote", ana, { bench: "qa", q: 1, hash, vote: 0 })).status).toBe(200);
  const qs = await listQuestions(app, ana);
  const first = qs.find((x) => x.bench === "qa" && x.q === 1)!;
  expect(first.votes).toEqual({ up: 0, down: 0 });
  expect(first.myVote).toBeNull();
  expect((await db.select().from(schema.questionValidations)).length).toBe(0);
});

it("validates at two distinct members, and only inside the org", async () => {
  const app = makeApp(fakeHermes());
  const hash = await hashOf("¿Cuál es la capital de Francia?");
  await req(app, "POST", "/api/org/questions/vote", ana, { bench: "qa", q: 1, hash, vote: 1 });
  // One validation is not enough.
  expect((await listQuestions(app, ana)).find((x) => x.q === 1)!.validated).toBe(false);
  await req(app, "POST", "/api/org/questions/vote", ana2, { bench: "qa", q: 1, hash, vote: 1 });
  const qs = await listQuestions(app, ana);
  const first = qs.find((x) => x.bench === "qa" && x.q === 1)!;
  expect(first.votes).toEqual({ up: 2, down: 0 });
  expect(first.myVote).toBe(1);
  expect(first.validated).toBe(true);
  // Ceci (org_otra) sees the same question with nobody's votes from uni.
  const ceciQs = await listQuestions(app, ceci);
  const hers = ceciQs.find((x) => x.bench === "qa" && x.q === 1)!;
  expect(hers.votes).toEqual({ up: 0, down: 0 });
  expect(hers.validated).toBe(false);
  // Her vote counts only for her org.
  await req(app, "POST", "/api/org/questions/vote", ceci, { bench: "qa", q: 1, hash, vote: -1 });
  expect((await listQuestions(app, ana)).find((x) => x.q === 1)!.votes).toEqual({ up: 2, down: 0 });
  expect((await listQuestions(app, ceci)).find((x) => x.q === 1)!.myVote).toBe(-1);
});

it("hides votes silently when the question text changes (qHash mismatch)", async () => {
  const hash = await hashOf("¿Cuál es la capital de Francia?");
  const app = makeApp(fakeHermes());
  await req(app, "POST", "/api/org/questions/vote", ana, { bench: "qa", q: 1, hash, vote: 1 });
  await req(app, "POST", "/api/org/questions/vote", ana2, { bench: "qa", q: 1, hash, vote: 1 });
  // Someone edits the question: the stored votes no longer match its text.
  const edited = makeApp(fakeHermes({ questions: { qa: "¿Cuál es la capital de España?" } }));
  const qs = await listQuestions(edited, ana);
  const first = qs.find((x) => x.bench === "qa" && x.q === 1)!;
  expect(first.question).toBe("¿Cuál es la capital de España?");
  expect(first.votes).toEqual({ up: 0, down: 0 });
  expect(first.myVote).toBeNull();
  expect(first.validated).toBe(false);
  // Voting again on the new text works and tallies from zero.
  const newHash = await hashOf("¿Cuál es la capital de España?");
  await req(edited, "POST", "/api/org/questions/vote", ana, { bench: "qa", q: 1, hash: newHash, vote: 1 });
  await req(edited, "POST", "/api/org/questions/vote", ana2, { bench: "qa", q: 1, hash: newHash, vote: 1 });
  const after = (await listQuestions(edited, ana)).find((x) => x.bench === "qa" && x.q === 1)!;
  expect(after.votes).toEqual({ up: 2, down: 0 });
  expect(after.validated).toBe(true);
});

it("rejects bodies that are not a valid vote", async () => {
  const app = makeApp(fakeHermes());
  const hash = "a".repeat(64);
  for (const body of [
    null,
    {},
    { bench: "qa", q: 0, hash, vote: 1 },
    { bench: "qa", q: 1.5, hash, vote: 1 },
    { bench: "../etc", q: 1, hash, vote: 1 },
    { bench: "qa", q: 1, hash: "nope", vote: 1 },
    { bench: "qa", q: 1, hash, vote: 2 },
    { bench: "qa", q: 1, hash, vote: "up" },
  ]) {
    expect((await req(app, "POST", "/api/org/questions/vote", ana, body)).status).toBe(400);
  }
  expect((await db.select().from(schema.questionValidations)).length).toBe(0);
});

it("logs each vote in the org's activity with kind peer", async () => {
  const app = makeApp(fakeHermes());
  const hash = await hashOf("¿Cuál es la capital de Francia?");
  await req(app, "POST", "/api/org/questions/vote", ana, { bench: "qa", q: 1, hash, vote: 1 });
  await req(app, "POST", "/api/org/questions/vote", ana, { bench: "qa", q: 1, hash, vote: 0 });
  const rows = await db.select().from(schema.activity).where(eq(schema.activity.orgId, "org_uni"));
  expect(rows.map((r) => r.kind)).toEqual(["peer", "peer"]);
  expect(rows[0]).toMatchObject({ bench: "qa", userId: "user_ana", detail: "marcó la pregunta 1 como válida" });
});

it("refuses cross-org writes with a well-formed body (votes stay in each org)", async () => {
  const app = makeApp(fakeHermes());
  const hash = await hashOf("¿Cuál es la capital de Francia?");
  await req(app, "POST", "/api/org/questions/vote", ana, { bench: "qa", q: 1, hash, vote: 1 });
  // Ceci voting on the same (bench, q) lands in HER org, never in uni's row.
  await req(app, "POST", "/api/org/questions/vote", ceci, { bench: "qa", q: 1, hash, vote: -1 });
  const rows = await db.select().from(schema.questionValidations);
  expect(rows.length).toBe(2);
  expect(new Set(rows.map((r) => r.orgId))).toEqual(new Set(["org_uni", "org_otra"]));
});
