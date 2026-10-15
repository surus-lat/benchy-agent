// The app's only backend: the Worker's /api/conversations and /api/workspace
// routes (same origin; the session cookie authenticates).

export type Conversation = { id: string; title: string | null; bench?: string | null; updatedAt: string };
export type Activity = { id: string; who: string; userId: string | null; bench: string | null; kind: string; detail: string; createdAt: string };
export type Message = { id: string; role: "user" | "assistant"; content: string; createdAt: string };
export type WorkspaceFile = { path: string; size: number; modified: number };
export type FileContent = WorkspaceFile & { truncated: boolean; content: string };

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `HTTP_${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  conversations: (bench?: string) =>
    call<{ conversations: Conversation[] }>(`/api/conversations${bench ? `?bench=${encodeURIComponent(bench)}` : ""}`),
  createConversation: (bench?: string) => call<{ id: string }>("/api/conversations", { method: "POST", body: JSON.stringify(bench ? { bench } : {}) }),
  /** Move a conversation to the benchmark it turned out to be about. */
  tagConversation: (id: string, bench: string) =>
    call<{ id: string }>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ bench }) }),
  activity: (bench?: string, limit = 50) =>
    call<{ activity: Activity[] }>(`/api/activity?limit=${limit}${bench ? `&bench=${encodeURIComponent(bench)}` : ""}`),
  /** Record what only the app knows happened; never blocks the action itself. */
  logActivity: (bench: string, kind: "create" | "approve" | "evaluate" | "report", detail: string) =>
    call<{ ok: true }>("/api/activity", { method: "POST", body: JSON.stringify({ bench, kind, detail }) }).catch(() => null),
  messages: (id: string) => call<{ messages: Message[] }>(`/api/conversations/${id}/messages`),
  sendTurn: (id: string, message: string) =>
    call<{ reply: string }>(`/api/conversations/${id}/turns`, { method: "POST", body: JSON.stringify({ message }) }),
  files: () => call<{ files: WorkspaceFile[]; truncated: boolean }>("/api/workspace/files"),
  file: (path: string) => call<FileContent>(`/api/workspace/file?path=${encodeURIComponent(path)}`),
  /** Write a benchmark text file; CONFLICT if it changed after `baseModified`. */
  write: (path: string, content: string, baseModified?: number) =>
    call<{ path: string; modified: number }>("/api/workspace/file", {
      method: "PUT",
      body: JSON.stringify({ path, content, baseModified }),
    }),
};

/** What to tell the researcher for each failure the Worker can return. */
export function errorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : "UNKNOWN";
  switch (code) {
    case "AGENT_NOT_PROVISIONED":
      return "El agente de tu organización todavía no está activo. Te avisamos apenas esté listo.";
    case "AGENT_TIMEOUT":
      return "El agente tardó demasiado en responder. Si estaba corriendo un benchmark grande, puede haber terminado igual: revisá la carpeta runs/ en Archivos.";
    case "AGENT_UNAVAILABLE":
      return "No pudimos comunicarnos con el agente. Probá de nuevo en un momento.";
    case "TURN_IN_PROGRESS":
      return "El agente todavía está respondiendo en esta conversación.";
    case "UNAUTHENTICATED":
      return "Tu sesión expiró. Volvé a ingresar.";
    case "CONFLICT":
      return "El examen cambió mientras editabas (quizás lo tocó el agente). Cargamos la última versión.";
    case "FORBIDDEN_PATH":
    case "TOO_LARGE":
      return "No se pudo guardar ese archivo.";
    case "NETWORK":
      return "Sin conexión. Revisá tu red y probá de nuevo.";
    default:
      return "Algo salió mal. Probá de nuevo en un momento.";
  }
}
