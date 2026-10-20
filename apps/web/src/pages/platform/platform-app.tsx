import { Link, useLocation, useRoute } from "wouter";
import AgentApp from "../app/agent-app";
import { PlatformProvider, usePlatform } from "./store";
import Home from "./home";
import BenchPage from "./bench";
import { NewBench } from "./new-bench";
import Account from "./account";
import Workspace from "./workspace";
import LibraryPage from "./library";
import ReportPage from "./report";
import { ProcessIndicator } from "./processes";
import "./platform.css";

// /app — the platform. Routes:
//   /app                    benchmarks home
//   /app/nuevo              a new benchmark: name, field, language; opens in A
//   /app/b/:slug/:stage?    one benchmark as two windows, A · Interfaz and
//                           B · Agente (autoria|revision|evaluacion|publicacion)
//   /app/b/:slug/informe    the findings report on the SURUS letterhead (prints to PDF)
//   /app/biblioteca         the paper library (CONICET Digital): search, read,
//                           add a paper to a benchmark
//   /app/cuenta             account
//   /app/v1/b/:slug/:tab?   DEPRECATED: the previous benchmark view (tabs, with a
//                           chat with the agent); deleted next release (bench.tsx)
//   /app/chat               the first view: plain chat + files

export default function PlatformApp() {
  const [isChat] = useRoute("/app/chat");
  const [isReport, rp] = useRoute("/app/b/:slug/informe");
  const [isWorkspace, ws] = useRoute("/app/b/:slug/:stage?");
  if (isChat)
    return (
      <>
        <AgentApp />
        <ProcessIndicator />
      </>
    );
  return (
    <PlatformProvider>
      <ProcessIndicator />
      {isReport ? (
        <ReportPage slug={decodeURIComponent(rp!.slug)} />
      ) : isWorkspace ? (
        <Workspace key={ws!.slug} slug={decodeURIComponent(ws!.slug)} stage={ws!.stage} />
      ) : (
        <Shell />
      )}
    </PlatformProvider>
  );
}

function Shell() {
  const { me, benches, notProvisioned } = usePlatform();
  const [location, navigate] = useLocation();
  const [, benchParams] = useRoute("/app/v1/b/:slug/:tab?");
  const [isNew] = useRoute("/app/nuevo");
  const [isAccount] = useRoute("/app/cuenta");
  const [isLibrary] = useRoute("/app/biblioteca");
  const activeSlug = benchParams?.slug ? decodeURIComponent(benchParams.slug) : null;
  const isHome = !activeSlug && !isNew && !isAccount && !isLibrary;

  return (
    <div className="bp">
      <header className="bp-top">
        <button className="bp-burger" onClick={() => navigate("/app")} aria-label="Benchmarks">
          ☰
        </button>
        <Link href="/app" className="bp-lockup" aria-label="benchy agent">
          <img src="/brand/pip-mark.svg" alt="" />
          <span className="name">benchy</span>
          <span className="suffix">agent</span>
        </Link>
        {me?.org && <span className="bp-org">{me.org.name}</span>}
        <div className="bp-top-right">
          <Link href="/app/biblioteca" className={`bp-viewswitch${isLibrary ? " on" : ""}`}>
            Biblioteca
          </Link>
          <Link href="/app/chat" className="bp-viewswitch legacy" title="Vista anterior: chat y archivos">
            Vista chat
          </Link>
          <span className="bp-email">{me?.user.email}</span>
          <button className="pill" onClick={() => navigate("/app/cuenta")}>
            Cuenta
          </button>
        </div>
      </header>

      {notProvisioned && (
        <div className="bp-banner" role="status">
          <span className="dot" style={{ background: "var(--amber)" }} />
          El agente de tu organización todavía no está activo. Te avisamos apenas esté listo.
          <span className="code">AGENT_NOT_PROVISIONED</span>
        </div>
      )}

      <div className="bp-body">
        <aside className="bp-side" aria-label="Benchmarks">
          <button className="bp-new" onClick={() => navigate("/app/nuevo")}>
            + Nuevo benchmark
          </button>
          <button className={`bp-nav${isHome ? " on" : ""}`} onClick={() => navigate("/app")}>
            <span>Todos los benchmarks</span>
          </button>
          <button className={`bp-nav${isLibrary ? " on" : ""}`} onClick={() => navigate("/app/biblioteca")}>
            <span>Biblioteca de papers</span>
          </button>
          <p className="eyebrow">Tu organización</p>
          {benches.map((b) => (
            <button
              key={b.slug}
              title={b.slug}
              className={`bp-nav${activeSlug === b.slug ? " on" : ""}`}
              onClick={() => navigate(`/app/b/${encodeURIComponent(b.slug)}/autoria`)}
            >
              <span className={`dot ${statusOf(b.validation)}`} />
              <span>{b.doc?.title ?? b.slug}</span>
            </button>
          ))}
          <div className="bp-side-foot">Los benchmarks son visibles para toda la organización. Las conversaciones son tuyas.</div>
        </aside>

        <main className="bp-main" key={location.split("/").slice(0, 4).join("/")}>
          {isAccount ? (
            <Account />
          ) : isLibrary ? (
            <LibraryPage />
          ) : isNew ? (
            <NewBench />
          ) : activeSlug ? (
            <BenchPage slug={activeSlug} tab={benchParams?.tab} />
          ) : (
            <Home />
          )}
        </main>
      </div>
    </div>
  );
}

export function statusOf(v: { ok: boolean } | undefined): "valid" | "error" | "draft" {
  if (!v) return "draft";
  return v.ok ? "valid" : "error";
}
