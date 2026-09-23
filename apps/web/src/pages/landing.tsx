import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { COPY, type Locale } from "./landing/copy";
import { RequestAccessForm } from "./landing/request-access-form";
import "./landing/landing.css";

// Public landing page, recreated from the design handoff. One layout, two
// locales (Spanish at /, English at /en). The "Request access" CTAs all anchor
// to #access; the form there is the only piece with real logic (see
// request-access-form.tsx). The only way into the app from here is "Log in" —
// there is deliberately no session-aware "Open app" affordance; /login sends
// an already-signed-in visitor on to /app itself.

const GITHUB_URL = "https://github.com/surus-lat/benchy-agent";
const ENGINE_URL = "https://benchy.lat";
const AWS_URL = "https://aws.amazon.com/what-is-cloud-computing";
const SURUS_URL = "https://surus.lat";

export default function Landing({ lang = "es" }: { lang?: Locale }) {
  const t = COPY[lang];
  useDocumentChrome(t.htmlLang);
  const railRef = useRailScrollSpy();
  const closerRef = useRevealOnce();

  const panels = [
    { id: "rail-1", title: t.rail.build.title, body: <BuildPanel t={t.rail.build} /> },
    { id: "rail-2", title: t.rail.generate.title, body: <GeneratePanel t={t.rail.generate} /> },
    { id: "rail-3", title: t.rail.systems.title, body: <SystemsPanel t={t.rail.systems} /> },
    { id: "rail-4", title: t.rail.run.title, body: <RunPanel t={t.rail.run} /> },
    { id: "rail-5", title: t.rail.explicit.title, body: <ExplicitPanel t={t.rail.explicit} /> },
  ];

  return (
    <div className={`lp lp-${lang}`}>
      <a className="lp-skip" href="#top">
        {t.nav.skip}
      </a>

      <header className="lp-header">
        <nav className="lp-nav">
          <a href="#top" className="lp-lockup">
            <img src="/brand/pip-mark.svg" alt="" />
            <span className="lp-lockup-words">
              <span className="lp-lockup-name">benchy</span>
              <span className="lp-lockup-suffix">agent</span>
            </span>
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="lp-nav-gh"
            aria-label={t.nav.github}
            title="benchy-agent on GitHub"
          >
            <GitHubMark />
          </a>
          <div className="lp-nav-center">
            <a href={ENGINE_URL} target="_blank" rel="noopener noreferrer" className="lp-nav-engine">
              {t.nav.engine}
            </a>
          </div>
          <div className="lp-nav-actions">
            <Link href="/login" className="lp-pill lp-pill-ghost">
              {t.nav.login}
            </Link>
            <a href="#access" className="lp-pill lp-pill-ink">
              {t.nav.request}
            </a>
          </div>
        </nav>
      </header>

      <main id="top" className="lp-main">
        <section className="lp-section lp-hero">
          <h1>
            <span>{t.hero.h1[0]}</span>
            <span>{t.hero.h1[1]}</span>
          </h1>
          <p className="lp-hero-sub">{t.hero.subtitle}</p>
          <div role="img" aria-label={t.hero.pipLabel} className="lp-pip lp-pip-thinking">
            <span className="lp-pip-bracket lp-pip-bracket-l" />
            <span className="lp-pip-center">
              <span className="lp-pip-dot" />
              <span className="lp-pip-dot" />
              <span className="lp-pip-dot" />
            </span>
            <span className="lp-pip-bracket lp-pip-bracket-r" />
          </div>
          <p className="lp-hero-p">{t.hero.paragraph}</p>
          <div className="lp-hero-cta">
            <a href="#access" className="lp-btn">
              {t.hero.cta}
            </a>
          </div>
        </section>

        <section className="lp-section lp-support">
          <div className="lp-card lp-support-card">
            <div className="lp-support-left">
              <a href={AWS_URL} target="_blank" rel="noopener noreferrer" className="lp-support-badge">
                <img src="/brand/powered-by-aws.png" alt={t.aws.badgeAlt} width={200} height={72} />
              </a>
              <p className="lp-support-lead">
                {t.aws.lead[0]}
                <span>{t.aws.lead[1]}</span>
                {t.aws.lead[2]}
              </p>
            </div>
            <p className="lp-support-body">{t.aws.body}</p>
          </div>
        </section>

        <section className="lp-section lp-platform">
          <figure>
            <div className="lp-platform-frame">
              <img src={t.platform.src} alt={t.platform.alt} width={2688} height={1826} loading="lazy" />
            </div>
            <figcaption className="lp-platform-caption">{t.platform.caption}</figcaption>
          </figure>
        </section>

        <section id="access" className="lp-section lp-access">
          <div className="lp-card lp-access-card">
            <div className="lp-access-intro">
              <p className="lp-eyebrow">{t.access.eyebrow}</p>
              <h2>{t.access.title}</h2>
              <p className="lp-access-body">{t.access.body}</p>
            </div>
            <RequestAccessForm t={t.access} />
          </div>
        </section>

        <section id="rail" className="lp-section lp-rail">
          <div className="lp-rail-grid" ref={railRef}>
            <nav className="lp-rail-nav" aria-label={t.rail.ariaLabel}>
              <div className="lp-rail-index">
                {panels.map((p, i) => (
                  <a key={p.id} href={`#${p.id}`} className="lp-rail-link" data-rail-nav={i + 1}>
                    {p.title}
                    <span className="lp-rail-track">
                      <span className="lp-rail-fill" data-rail-fill />
                    </span>
                  </a>
                ))}
              </div>
            </nav>
            <div className="lp-panels">
              {panels.map((p, i) => (
                <article key={p.id} id={p.id} className="lp-panel" data-rail-panel={i + 1}>
                  <h2>{p.title}</h2>
                  {p.body}
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="closer" className="lp-closer" ref={closerRef}>
          <div className="lp-closer-mark" data-closer-mark>
            <div role="img" aria-label={t.closer.pipLabel} className="lp-pip lp-pip-idle">
              <span className="lp-pip-bracket lp-pip-bracket-l" />
              <span className="lp-pip-center">
                <span className="lp-pip-dot" />
              </span>
              <span className="lp-pip-bracket lp-pip-bracket-r" />
            </div>
          </div>
          <h2>{t.closer.title}</h2>
          <a href="#access" className="lp-btn">
            {t.closer.cta}
          </a>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <a href={SURUS_URL} target="_blank" rel="noopener noreferrer">
            {t.footer.by}
          </a>
          <span className="lp-footer-sep" aria-hidden="true">
            ·
          </span>
          <Link href={t.footer.switchHref} className="lp-footer-lang" title={t.footer.switchTitle}>
            {t.footer.switchLabel}
          </Link>
        </div>
      </footer>
    </div>
  );
}

/* ---- Feature panels ------------------------------------------------- */

type Rail = (typeof COPY)["en"]["rail"];

function BuildPanel({ t }: { t: Rail["build"] }) {
  return (
    <>
      <p className="lp-panel-lede">{t.lede}</p>
      <div className="lp-inset lp-build">
        <div className="lp-build-head">
          <img src="/brand/pip-mark.svg" alt="" />
          <span>{t.quote}</span>
        </div>
        <div className="lp-build-grid">
          {t.blocks.map((b) => (
            <div key={b.label} className="lp-build-cell">
              <p className="lp-mono-label">{b.label}</p>
              <pre>{b.lines}</pre>
            </div>
          ))}
        </div>
      </div>
      <p className="lp-panel-note">{t.note}</p>
    </>
  );
}

function GeneratePanel({ t }: { t: Rail["generate"] }) {
  return (
    <>
      <p className="lp-panel-lede">{t.lede}</p>
      <div className="lp-inset lp-gen">
        <div className="lp-gen-head">
          <span>{t.headLeft}</span>
          <span>{t.headRight}</span>
        </div>
        <div className="lp-gen-rows">
          {t.rows.map((r) => (
            <div key={r.index} className={`lp-item-row${r.rejected ? " is-rejected" : ""}`}>
              <span className="lp-item-idx">{r.index}</span>
              <span className="lp-item-text">{r.text}</span>
              <span className="lp-item-status">{r.status}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="lp-panel-note">{t.note}</p>
    </>
  );
}

function SystemsPanel({ t }: { t: Rail["systems"] }) {
  return (
    <>
      <p className="lp-panel-lede">{t.lede}</p>
      <div className="lp-chips">
        {t.chips.map((c) => (
          <div key={c} className="lp-chip">
            {c}
          </div>
        ))}
      </div>
      <div className="lp-inset lp-contract">
        <p>{t.contract}</p>
      </div>
      <p className="lp-panel-note">{t.note}</p>
    </>
  );
}

function RunPanel({ t }: { t: Rail["run"] }) {
  return (
    <>
      <p className="lp-panel-lede">{t.lede}</p>
      <figure className="lp-scores">
        <div className="lp-scores-head">
          <span>{t.metaLeft}</span>
          <span>{t.metaRight}</span>
        </div>
        <div className="lp-scores-rows">
          {t.rows.map((r) => (
            <div key={r.label} className={`lp-score-row${r.primary ? "" : " is-secondary"}`}>
              <span className="lp-score-label">{r.label}</span>
              <span className="lp-score-bar" style={{ width: `${Math.round(r.value * 100)}%` }} />
              <span className="lp-score-val">{r.value.toFixed(2)}</span>
            </div>
          ))}
        </div>
        <figcaption className="lp-scores-caption">{t.caption}</figcaption>
      </figure>
    </>
  );
}

function ExplicitPanel({ t }: { t: Rail["explicit"] }) {
  return (
    <>
      <p className="lp-panel-lede">{t.lede}</p>
      <p className="lp-panel-lede">{t.lede2}</p>
      <div className="lp-inset lp-pipeline">
        <div className="lp-pipeline-row">
          <div className="lp-pipeline-sources">
            {t.sources.map((s) => (
              <span key={s} className="lp-node">
                {s}
              </span>
            ))}
          </div>
          <div className="lp-pipeline-steps">
            {t.steps.map((s, i) => (
              // Each arrow is grouped with the node it points to so a wrap
              // never orphans a connector.
              <div key={s} className="lp-step">
                <span className="lp-arrow" aria-hidden="true">
                  →
                </span>
                <span className={`lp-node${i === 0 ? " lp-node-yaml" : ""}`}>{s}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="lp-panel-note">{t.note}</p>
    </>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.88.51-1.08-1.78-.2-2.91-.88-2.91-2.77 0-.54.19-1.05.51-1.45-.05-.12-.22-.63.05-1.31 0 0 .61-.19 2 .75a4.9 4.9 0 0 1 2.66 0c1.39-.95 2-.75 2-.75.27.68.1 1.19.05 1.31.32.4.51.9.51 1.45 0 1.9-1.13 2.57-2.92 2.77.29.26.55.75.55 1.52 0 1.09-.01 1.97-.01 2.24 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/* ---- Behaviour ------------------------------------------------------ */

/**
 * The dot-grid ground and the document language belong to <html>/<body>,
 * which React does not own; toggle them for as long as the landing is
 * mounted so the app under /app keeps its own theme.
 */
function useDocumentChrome(htmlLang: string) {
  useEffect(() => {
    const html = document.documentElement;
    const previousLang = html.lang;
    html.classList.add("lp-html");
    html.lang = htmlLang;
    return () => {
      html.classList.remove("lp-html");
      html.lang = previousLang;
    };
  }, [htmlLang]);
}

/**
 * Scroll-spy for the feature rail (desktop only; the index is hidden below
 * 880px). The active panel is the last one whose top has crossed 35% of the
 * viewport; its index item gets an amber fill scaled by progress through the
 * panel. Mutates the DOM directly inside one rAF per scroll frame — pushing
 * this through React state would re-render the whole page on every frame.
 */
function useRailScrollSpy() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const panels = Array.from(root.querySelectorAll<HTMLElement>("[data-rail-panel]"));
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("[data-rail-nav]"));
    if (!panels.length || !links.length) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.35;
      let i = 0;
      panels.forEach((p, k) => {
        if (p.getBoundingClientRect().top <= line) i = k;
      });
      const top = panels[i].getBoundingClientRect().top;
      const next = panels[i + 1];
      const span = next ? next.getBoundingClientRect().top - top : panels[i].getBoundingClientRect().height;
      const progress = span > 0 ? Math.max(0, Math.min(1, (line - top) / span)) : 0;
      const active = panels[i].dataset.railPanel;
      for (const a of links) {
        const on = a.dataset.railNav === active;
        if (on) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
        const fill = a.querySelector<HTMLElement>("[data-rail-fill]");
        if (fill) fill.style.transform = `scaleX(${on ? progress : 0})`;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);
  return ref;
}

/**
 * One-way reveal of the closer mascot once the closer section's top crosses
 * 80% of the viewport. Never re-hides.
 */
function useRevealOnce() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const section = ref.current;
    const mark = section?.querySelector<HTMLElement>("[data-closer-mark]");
    if (!section || !mark) return;
    if (!("IntersectionObserver" in window)) {
      mark.classList.add("is-visible");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          mark.classList.add("is-visible");
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -20% 0px" },
    );
    io.observe(section);
    return () => io.disconnect();
  }, []);
  return ref;
}
