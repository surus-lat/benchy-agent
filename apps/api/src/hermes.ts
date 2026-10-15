// Client for one org's Hermes API server (apps/agent, on Railway). The Worker
// is its only caller: the browser never sees a Hermes URL, session id or key.

import type { Paper } from "./library";

export type HermesTurn = { reply: string; usage: unknown };
export type WorkspaceFile = { path: string; size: number; modified: number };
export type WorkspaceFileContent = WorkspaceFile & { truncated: boolean; content: string };

export interface HermesClient {
  /** Start a Hermes session; returns its id. */
  createSession(userId: string): Promise<string>;
  /** One synchronous agent turn in an existing session. */
  chat(sessionId: string, userId: string, message: string, speaker: string): Promise<HermesTurn>;
  /** The org workspace (benchmarks, exams, runs), via the container's /benchy routes. */
  listFiles(): Promise<{ files: WorkspaceFile[]; truncated: boolean }>;
  /** One workspace file, or null if it does not exist. */
  readFile(path: string): Promise<WorkspaceFileContent | null>;
  /** Compile a benchmark.yaml with the engine: ok, or the exact error. */
  validate(path: string): Promise<unknown>;
  /** Every exam row of a benchmark checked against its program. */
  exam(path: string): Promise<unknown>;
  /** The models a benchmark may run. */
  models(): Promise<unknown>;
  /** Write one benchmark text file; refused if it changed after `baseModified`. */
  writeFile(path: string, content: string, baseModified?: number): Promise<WriteResult>;
  /** Grade a rubric benchmark's expert answers with its grader (writes review.json). */
  review(path: string): Promise<unknown>;
  /** Add a library paper to a benchmark: the container fetches its PDF and keeps the text. */
  addSource(bench: string, paper: Paper): Promise<SourceResult>;
  /** Add a PDF the researcher uploaded to a benchmark. */
  uploadSource(bench: string, filename: string, pdf: ArrayBuffer): Promise<SourceResult>;
  /** Take a paper out of a benchmark (questions that cite it keep the citation). */
  removeSource(bench: string, id: string): Promise<{ ok: boolean }>;
}

/** A paper in a benchmark, as the container lists it in <bench>/sources.json. */
export type Source = {
  id: string;
  origin: "conicet" | "upload";
  title: string;
  authors: string[];
  year: number | null;
  url: string | null;
  pdf_url: string | null;
  file: string;
  pages: number;
  chars: number;
  /** "abstract" when there was no PDF or no text in it: only the abstract is kept. */
  text: "full" | "abstract";
  added: number;
};

export type SourceResult = { ok: true; source: Source } | { ok: false; error: { code: string; message: string } };

export type WriteResult =
  | { status: "ok"; path: string; modified: number }
  | { status: "conflict"; modified: number }
  | { status: "forbidden" }
  | { status: "too_large" };

export class HermesError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A turn may run a whole benchmark (one model call per exam row). */
const TURN_TIMEOUT_MS = 14 * 60 * 1000;
const SESSION_TIMEOUT_MS = 30 * 1000;
/** Fetching a PDF and extracting its text. */
const SOURCE_TIMEOUT_MS = 2 * 60 * 1000;

export function hermesClient(baseUrl: string, apiKey: string): HermesClient {
  const root = baseUrl.replace(/\/+$/, "");

  async function call(path: string, userId: string, body: unknown, timeoutMs: number) {
    let res: Response;
    try {
      res = await fetch(root + path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          // Scopes Hermes's long-term memory per researcher where a memory
          // provider supports it; harmless with the default file memory.
          "x-hermes-session-key": `user:${userId}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new HermesError(timedOut ? "agent timed out" : "agent unreachable", timedOut ? 504 : 502);
    }
    if (!res.ok) {
      throw new HermesError(`agent returned ${res.status}`, 502);
    }
    return (await res.json()) as Record<string, any>;
  }

  async function get(path: string): Promise<Response> {
    try {
      return await fetch(root + path, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
      });
    } catch {
      throw new HermesError("agent unreachable", 502);
    }
  }

  async function json(res: Response): Promise<unknown> {
    if (!res.ok) throw new HermesError(`agent returned ${res.status}`, 502);
    return res.json();
  }

  async function send(method: string, path: string, init: { body?: BodyInit; type?: string }, timeoutMs: number): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
    if (init.type) headers["content-type"] = init.type;
    try {
      return await fetch(root + path, { method, headers, body: init.body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new HermesError(timedOut ? "agent timed out" : "agent unreachable", timedOut ? 504 : 502);
    }
  }

  return {
    async listFiles() {
      const res = await get("/benchy/files");
      if (!res.ok) throw new HermesError(`agent returned ${res.status}`, 502);
      return (await res.json()) as { files: WorkspaceFile[]; truncated: boolean };
    },
    async readFile(path) {
      const res = await get(`/benchy/file?path=${encodeURIComponent(path)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new HermesError(`agent returned ${res.status}`, 502);
      return (await res.json()) as WorkspaceFileContent;
    },
    async validate(path) {
      return json(await get(`/benchy/validate?path=${encodeURIComponent(path)}`));
    },
    async exam(path) {
      return json(await get(`/benchy/exam?path=${encodeURIComponent(path)}`));
    },
    async models() {
      return json(await get("/benchy/models"));
    },
    async writeFile(path, content, baseModified) {
      let res: Response;
      try {
        res = await fetch(root + "/benchy/file", {
          method: "PUT",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ path, content, base_modified: baseModified }),
          signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
        });
      } catch {
        throw new HermesError("agent unreachable", 502);
      }
      if (res.status === 409) return { status: "conflict", modified: ((await res.json()) as { modified: number }).modified };
      if (res.status === 403 || res.status === 400) return { status: "forbidden" };
      if (res.status === 413) return { status: "too_large" };
      const body = (await json(res)) as { path: string; modified: number };
      return { status: "ok", ...body };
    },
    async review(path) {
      let res: Response;
      try {
        res = await fetch(root + `/benchy/review?path=${encodeURIComponent(path)}`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        throw new HermesError(timedOut ? "agent timed out" : "agent unreachable", timedOut ? 504 : 502);
      }
      return json(res);
    },
    async addSource(bench, paper) {
      const res = await send("POST", "/benchy/sources", { body: JSON.stringify({ bench, paper }), type: "application/json" }, SOURCE_TIMEOUT_MS);
      return (await json(res)) as SourceResult;
    },
    async uploadSource(bench, filename, pdf) {
      const q = `bench=${encodeURIComponent(bench)}&name=${encodeURIComponent(filename)}`;
      const res = await send("POST", `/benchy/sources/upload?${q}`, { body: pdf, type: "application/pdf" }, SOURCE_TIMEOUT_MS);
      return (await json(res)) as SourceResult;
    },
    async removeSource(bench, id) {
      const res = await send("DELETE", `/benchy/sources?bench=${encodeURIComponent(bench)}&id=${encodeURIComponent(id)}`, {}, SESSION_TIMEOUT_MS);
      return (await json(res)) as { ok: boolean };
    },
    async createSession(userId) {
      const data = await call("/api/sessions", userId, {}, SESSION_TIMEOUT_MS);
      const id = data.session?.id ?? data.session_id ?? data.id;
      if (typeof id !== "string") throw new HermesError("agent returned no session id", 502);
      return id;
    },
    async chat(sessionId, userId, message, speaker) {
      const data = await call(
        `/api/sessions/${encodeURIComponent(sessionId)}/chat`,
        userId,
        { message, system_message: speaker },
        TURN_TIMEOUT_MS,
      );
      const reply = data.message?.content;
      if (typeof reply !== "string") throw new HermesError("agent returned no reply", 502);
      return { reply, usage: data.usage ?? null };
    },
  };
}
