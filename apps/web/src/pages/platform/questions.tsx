import { useCallback, useEffect, useState } from "react";
import { api, ApiError, errorText, type PeerQuestion } from "./data";
import { groupByBench, keyOf, scoreOf, truncate } from "./questions-model";
import "./questions.css";

// Preguntas de tu organización (issue #1): todas las preguntas de todos los
// benchmarks, para que cada miembro valide o rechace las preguntas de sus
// compañeros. Con dos validaciones (y más validaciones que rechazos) la
// pregunta queda "Validada". Cada miembro vota una sola vez por pregunta: el
// voto nuevo reemplaza al anterior, y se puede quitar. Si alguien edita la
// pregunta, los votos viejos dejan de contar hasta que la vuelvan a validar
// sobre el texto actual.

export default function QuestionsPage() {
  const [questions, setQuestions] = useState<PeerQuestion[] | null>(null);
  const [truncatedFlag, setTruncatedFlag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.orgQuestions();
      setQuestions(r.questions);
      setTruncatedFlag(r.truncated);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "AGENT_NOT_PROVISIONED"
          ? "El agente de tu organización todavía no está activo; apenas esté listo podrás revisar sus preguntas."
          : errorText(err),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function vote(q: PeerQuestion, next: 1 | -1 | 0) {
    setBusy(keyOf(q));
    try {
      await api.voteQuestion({ bench: q.bench, q: q.q, hash: q.hash, vote: next });
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  // Agrupadas por benchmark; dentro de cada una, primero las mejor puntuadas.
  const groups = groupByBench(questions ?? []);
  const total = questions?.length ?? 0;
  const loading = questions === null && !error;

  return (
    <section className="bp-page">
      <div>
        <h1 className="bp-h1">Preguntas de tu organización</h1>
        <p style={{ margin: "6px 0 0", fontSize: 14 }} className="body">
          {loading
            ? "Cargando…"
            : total === 0
              ? "Todavía no hay preguntas para revisar. Cuando un benchmark tenga su examen, aparecen acá."
              : `${total} ${total === 1 ? "pregunta" : "preguntas"} de ${groups.length} ${groups.length === 1 ? "benchmark" : "benchmarks"}. Con dos validaciones la pregunta queda validada.`}
        </p>
      </div>

      {error && (
        <p className="bp-error" style={{ marginTop: 16 }}>
          No pudimos cargar las preguntas. {error}
        </p>
      )}
      {truncatedFlag && (
        <p className="body" style={{ marginTop: 12 }}>
          Mostramos las primeras {total} preguntas: tu organización tiene más de las que entra en una página.
        </p>
      )}

      {groups.map(([bench, qs]) => (
        <div key={bench} className="card" style={{ marginTop: 24, overflow: "hidden" }}>
          <div className="card-head">
            <strong>{bench}</strong>
            <span className="bp-chip" style={{ marginLeft: 10 }}>
              {qs.filter((q) => q.validated).length} de {qs.length} validadas
            </span>
          </div>
          {qs.map((q) => {
            const key = keyOf(q);
            const open = expanded.has(key);
            const long = q.question.length > truncate(q.question).length;
            const score = scoreOf(q);
            return (
              <div key={key} className={`pr-row${q.validated ? " validated" : ""}`}>
                <div className="pr-main">
                  <span className="pr-qnum">Pregunta {q.q}</span>
                  <p className="pr-text">
                    {open || !long ? q.question : truncate(q.question)}
                    {long && (
                      <button
                        className="pr-expand"
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      >
                        {open ? "Mostrar menos" : "Ver completa"}
                      </button>
                    )}
                  </p>
                  {open && q.expectedAnswer && (
                    <p className="pr-answer">
                      <span className="eyebrow">Respuesta esperada</span>
                      {q.expectedAnswer}
                    </p>
                  )}
                </div>
                <div className="pr-side">
                  {q.validated && (
                    <span className="pr-badge" title="Acumuló dos o más validaciones sin rechazos que las superen">
                      Validada
                    </span>
                  )}
                  <span
                    className={`pr-score${score > 0 ? " up" : score < 0 ? " down" : ""}`}
                    title={`${q.votes.up} ${q.votes.up === 1 ? "miembro la valida" : "miembros la validan"} · ${q.votes.down} ${q.votes.down === 1 ? "la rechaza" : "la rechazan"}`}
                  >
                    {score > 0 ? `+${score}` : score}
                  </span>
                  <div className="pr-buttons">
                    <button
                      className={`pill pr-valida${q.myVote === 1 ? " on" : ""}`}
                      disabled={busy === key}
                      onClick={() => vote(q, q.myVote === 1 ? 0 : 1)}
                      title={q.myVote === 1 ? "Ya la validaste: tocá para quitar tu voto" : "Valida esta pregunta"}
                    >
                      Valida
                    </button>
                    <button
                      className={`pill pr-rechaza${q.myVote === -1 ? " on" : ""}`}
                      disabled={busy === key}
                      onClick={() => vote(q, q.myVote === -1 ? 0 : -1)}
                      title={q.myVote === -1 ? "Ya la marcaste para rechazar: tocá para quitar tu voto" : "Rechaza esta pregunta"}
                    >
                      Rechaza
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
