import { Link, useLocation, useRoute } from "wouter";
import AgentApp from "../app/agent-app";
import { PlatformProvider, usePlatform } from "./store";
import Home from "./home";
import BenchPage, { NewBench } from "./bench";
import Account from "./account";
import "./platform.css";

// /app — state A of the platform (benchmarks first), with state B (the plain
// chat + files view, pages/app/agent-app.tsx) kept at /app/chat while the
// product settles. Routes:
//   /app                 benchmarks home
//   /app/nuevo           a new benchmark, started with the agent
//   /app/b/:slug/:tab?   one benchmark (definicion|examen|sistemas|corridas|resultados|historial)
//   /app/cuenta          account
//   /app/chat            state B

export default function PlatformApp() {
  const [isChat] = useRoute("/app/chat");
  if (isChat) return <AgentApp />;
  return (
    <PlatformProvider>
      <Shell />
    </PlatformProvider>
  );
}

function Shell() {
  const { me, benches, notProvisioned } = usePlatform();
  const [location, navigate] = useLocation();
  const [, benchParams] = useRoute("/app/b/:slug/:tab?");
  const [isNew] = useRoute("/app/nuevo");
  const [isAccount] = useRoute("/app/cuenta");
  const activeSlug = benchParams?.slug ? decodeURIComponent(benchParams.slug) : null;
  const isHome = !activeSlug && !isNew && !isAccount;

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
          <Link href="/app/chat" className="bp-viewswitch" title="Vista anterior: chat y archivos">
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
          <p className="eyebrow">Tu organización</p>
          {benches.map((b) => (
            <button
              key={b.slug}
              title={b.slug}
              className={`bp-nav${activeSlug === b.slug ? " on" : ""}`}
              onClick={() => navigate(`/app/b/${encodeURIComponent(b.slug)}/definicion`)}
            >
              <span className={`dot ${statusOf(b.validation)}`} />
              <span>{b.doc?.title ?? b.slug}</span>
            </button>
          ))}
          <div className="bp-side-foot">Los benchmarks son visibles para toda la organización. Las conversaciones son tuyas.</div>
        </aside>

        <main className="bp-main" key={location.split("/").slice(0, 4).join("/")}>
          {isAccount ? <Account /> : isNew ? <NewBench /> : activeSlug ? <BenchPage slug={activeSlug} tab={benchParams?.tab} /> : <Home />}
        </main>
      </div>
    </div>
  );
}

export function statusOf(v: { ok: boolean } | undefined): "valid" | "error" | "draft" {
  if (!v) return "draft";
  return v.ok ? "valid" : "error";
}
