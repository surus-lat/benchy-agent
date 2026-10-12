// Client for one org's Hermes API server (apps/agent, on Railway). The Worker
// is its only caller: the browser never sees a Hermes URL, session id or key.

export type HermesTurn = { reply: string; usage: unknown };

export interface HermesClient {
  /** Start a Hermes session; returns its id. */
  createSession(userId: string): Promise<string>;
  /** One synchronous agent turn in an existing session. */
  chat(sessionId: string, userId: string, message: string, speaker: string): Promise<HermesTurn>;
}

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

  return {
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
