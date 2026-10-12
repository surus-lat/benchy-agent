import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { signOut, useSession } from "@/lib/auth-client";
import { api, errorText, type Conversation, type FileContent, type Message, type WorkspaceFile } from "./api";
import "./app.css";

// /app: the researcher's workspace. Conversations with the org's Benchy Agent
// on the left, the chat in the middle, the org's benchmark files on the right.
// Everything goes through the Worker; the agent writes the files, this page
// only reads them.

const SUGGESTIONS = [
  "Quiero medir qué tan bien conocen los modelos de IA mi área de investigación. ¿Por dónde empezamos?",
  "Ayudame a convertir una rúbrica de evaluación en un benchmark.",
  "¿Qué modelos puedo evaluar y en qué se diferencian?",
];

export default function AgentApp() {
  const { data: session } = useSession();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => new URLSearchParams(location.search).get("c"));
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<FileContent | null>(null);
  const [panel, setPanel] = useState<"none" | "chats" | "files">("none");
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations((await api.conversations()).conversations);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const refreshFiles = useCallback(async () => {
    try {
      setFiles((await api.files()).files);
      setFilesError(null);
    } catch (err) {
      setFilesError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
    void refreshFiles();
  }, [refreshConversations, refreshFiles]);

  // Keep the active conversation in the URL so a reload lands on it.
  useEffect(() => {
    const url = new URL(location.href);
    if (activeId) url.searchParams.set("c", activeId);
    else url.searchParams.delete("c");
    history.replaceState(null, "", url);
  }, [activeId]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingMessages(true);
    setError(null);
    api
      .messages(activeId)
      .then((r) => !cancelled && setMessages(r.messages))
      .catch((err) => {
        if (cancelled) return;
        // A stale ?c= (someone else's id, or deleted) falls back to a new chat.
        setActiveId(null);
        if (!(err instanceof Error && err.message === "NOT_FOUND")) setError(errorText(err));
      })
      .finally(() => !cancelled && setLoadingMessages(false));
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || pending) return;
    setPending(true);
    setError(null);
    setDraft("");
    const local: Message = { id: `local-${Date.now()}`, role: "user", content: message, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, local]);
    try {
      // Conversations are created on the first message, not on page visit.
      let id = activeId;
      if (!id) {
        id = (await api.createConversation()).id;
        setActiveId(id);
      }
      const { reply } = await api.sendTurn(id, message);
      setMessages((m) => [
        ...m,
        { id: `local-reply-${Date.now()}`, role: "assistant", content: reply, createdAt: new Date().toISOString() },
      ]);
    } catch (err) {
      setError(errorText(err));
      if (!activeId) setDraft(message); // nothing was saved; give the text back
    } finally {
      setPending(false);
      void refreshConversations();
      void refreshFiles(); // the agent may have written or run something
    }
  }

  function newChat() {
    setActiveId(null);
    setMessages([]);
    setError(null);
    setPanel("none");
  }

  const email = session?.user.email ?? "";

  return (
    <div className="ba-app">
      <header className="ba-top">
        <button className="ba-icon-btn ba-only-narrow" onClick={() => setPanel(panel === "chats" ? "none" : "chats")} aria-label="Conversaciones">
          ☰
        </button>
        <a href="/app" className="ba-lockup" aria-label="benchy agent">
          <img src="/brand/pip-mark.svg" alt="" />
          <span className="ba-lockup-name">benchy</span>
          <span className="ba-lockup-suffix">agent</span>
        </a>
        <div className="ba-top-right">
          <button className="ba-pill ba-only-medium" onClick={() => setPanel(panel === "files" ? "none" : "files")}>
            Archivos
          </button>
          <span className="ba-user" title={email}>{email}</span>
          <button className="ba-pill" onClick={() => void signOut().then(() => (location.href = "/"))}>
            Salir
          </button>
        </div>
      </header>

      <div className={`ba-body panel-${panel}`}>
        <aside className="ba-chats" aria-label="Conversaciones">
          <button className="ba-new" onClick={newChat}>+ Nueva conversación</button>
          <nav>
            {conversations.length === 0 && <p className="ba-muted ba-pad">Todavía no hay conversaciones.</p>}
            {conversations.map((c) => (
              <button
                key={c.id}
                className={`ba-chat-item${c.id === activeId ? " is-active" : ""}`}
                onClick={() => {
                  setActiveId(c.id);
                  setPanel("none");
                }}
              >
                {c.title || "Conversación nueva"}
              </button>
            ))}
          </nav>
        </aside>

        <main className="ba-main">
          <div className="ba-thread">
            {!activeId && messages.length === 0 && !pending ? (
              <Welcome onPick={(s) => setDraft(s)} name={nameFrom(email)} />
            ) : (
              <>
                {loadingMessages && <p className="ba-muted ba-center">Cargando…</p>}
                {messages.map((m) => (
                  <MessageView key={m.id} message={m} />
                ))}
                {pending && <Working />}
              </>
            )}
            {error && <p className="ba-error" role="alert">{error}</p>}
            <div ref={bottomRef} />
          </div>
          <Composer value={draft} onChange={setDraft} onSend={() => void send(draft)} disabled={pending} />
        </main>

        <aside className="ba-files" aria-label="Archivos de la organización">
          <div className="ba-files-head">
            <span>Archivos de tu organización</span>
            <button className="ba-icon-btn" onClick={() => void refreshFiles()} aria-label="Actualizar">↻</button>
          </div>
          <FileTree files={files} error={filesError} onOpen={(p) => void api.file(p).then(setOpenFile, (e) => setFilesError(errorText(e)))} />
        </aside>
      </div>

      {openFile && <FileViewer file={openFile} onClose={() => setOpenFile(null)} />}
    </div>
  );
}

function nameFrom(email: string) {
  const local = email.split("@")[0] ?? "";
  return local ? local.charAt(0).toUpperCase() + local.slice(1).split(/[._-]/)[0] : "";
}

function Welcome({ onPick, name }: { onPick: (s: string) => void; name: string }) {
  return (
    <div className="ba-welcome">
      <Pip state="idle" />
      <h1>{name ? `Hola, ${name}.` : "Hola."} ¿Qué querés evaluar?</h1>
      <p>
        Contale al agente qué sabe tu campo que los modelos de IA deberían saber. Diseña el benchmark con vos,
        arma el examen, lo corre contra distintos modelos y te explica los resultados.
      </p>
      <div className="ba-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => onPick(s)}>{s}</button>
        ))}
      </div>
    </div>
  );
}

function MessageView({ message }: { message: Message }) {
  if (message.role === "user") {
    return <div className="ba-msg ba-msg-user">{message.content}</div>;
  }
  return (
    <div className="ba-msg ba-msg-agent">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
    </div>
  );
}

function Working() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="ba-working" role="status">
      <Pip state="thinking" />
      <span>
        El agente está trabajando{seconds >= 20 ? " — si está corriendo un benchmark puede tardar unos minutos" : ""}…
      </span>
      <span className="ba-muted ba-mono">{seconds}s</span>
    </div>
  );
}

function Composer({ value, onChange, onSend, disabled }: { value: string; onChange: (v: string) => void; onSend: () => void; disabled: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [value]);
  return (
    <form
      className="ba-composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder="Escribile al agente…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSend();
          }
        }}
        aria-label="Mensaje para el agente"
      />
      <button type="submit" className="ba-send" disabled={disabled || !value.trim()}>Enviar</button>
    </form>
  );
}

function FileTree({ files, error, onOpen }: { files: WorkspaceFile[] | null; error: string | null; onOpen: (path: string) => void }) {
  const groups = useMemo(() => {
    const byFolder = new Map<string, WorkspaceFile[]>();
    for (const f of files ?? []) {
      const folder = f.path.includes("/") ? f.path.split("/")[0] : "";
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), f]);
    }
    return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);

  if (error) return <p className="ba-muted ba-pad">{error}</p>;
  if (files === null) return <p className="ba-muted ba-pad">Cargando…</p>;
  if (files.length === 0)
    return <p className="ba-muted ba-pad">Acá van a aparecer los benchmarks, exámenes y corridas que arme el agente.</p>;

  return (
    <div className="ba-tree">
      {groups.map(([folder, list]) => (
        <section key={folder || "_root"}>
          {folder && <h3>{folder}</h3>}
          {list.map((f) => (
            <button key={f.path} className="ba-file" onClick={() => onOpen(f.path)} title={f.path}>
              <span className="ba-mono">{folder ? f.path.slice(folder.length + 1) : f.path}</span>
              <span className="ba-muted">{formatSize(f.size)}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

function FileViewer({ file, onClose }: { file: FileContent; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const pretty = file.path.endsWith(".json") ? tryPretty(file.content) : file.content;
  return (
    <div className="ba-overlay" onClick={onClose}>
      <div className="ba-viewer" role="dialog" aria-label={file.path} onClick={(e) => e.stopPropagation()}>
        <div className="ba-viewer-head">
          <span className="ba-mono">{file.path}</span>
          <button className="ba-icon-btn" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <pre>{pretty}</pre>
        {file.truncated && <p className="ba-muted ba-pad">Mostrando el primer megabyte.</p>}
      </div>
    </div>
  );
}

function Pip({ state }: { state: "idle" | "thinking" }) {
  return (
    <span className={`ba-pip ba-pip-${state}`} aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

function tryPretty(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
