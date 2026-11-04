---
name: benchy-evaluation-criteria
description: Decide what a benchmark sets out to evaluate before writing any questions — the purpose, the construct, the failure modes and the limits in design.json, plus the rubric criteria the judge will apply to every answer. Use at the start of an open-question benchmark, when the researcher asks what to evaluate, or when the criteria need to be rewritten, reweighted or made checkable.
---
# Evaluation criteria: decide what the benchmark measures

The researcher's expertise decides *what is worth finding out*; you turn it into
an explicit design and a rubric the judge can apply. Never start by writing
questions. A question written before the criteria is a question nobody can score.

The app shows this as **01 · Criterios**. Two files carry the result:

```
/opt/data/workspace/<slug>/design.json      what we want to find out (both edit it)
/opt/data/workspace/<slug>/benchmark.yaml   the rubric the judge applies
```

## 1. The design (`design.json`)

A single JSON object, read and written by the app and by you:

```json
{
  "purpose": "What question the benchmark answers.",
  "construct": "What a model that masters the subject should be able to do.",
  "failureModes": "The errors or blind spots the exam should expose.",
  "notes": "What the score captures and what it leaves out.",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

- **purpose** is the researcher's question, in their words: one or two sentences.
  If they say "I want to know if models understand X", ask what would count as
  understanding and what would count as only sounding plausible.
- **construct** is a capability, not a topic: reconstruct an argument, situate a
  case, distinguish positions, choose a method and justify it. Avoid "knows the
  bibliography".
- **failureModes** are the wrong answers the exam should catch: confusing the
  author's thesis with a commentator's, citing from memory, mixing traditions,
  answering from the title, overgeneralising a local case.
- **notes** are the limits: what the score does not measure (style, originality,
  writing quality) and what a reader should not conclude from it.

Ask, do not invent. A useful sequence:

1. "¿Qué querés averiguar sobre los modelos en tu campo?"
2. "¿Qué debería poder hacer uno que realmente domina el tema, que uno que solo
   repite?"
3. "¿Qué error te haría desconfiar de una respuesta?"
4. "¿Qué no mide este examen, aunque alguien pueda leerlo así?"

Write their answers into `design.json` and read them back for correction. When
the app has already filled some fields, keep the researcher's wording: edit what
is missing or unclear, do not replace the whole design.

## 2. The criteria (`benchmark.yaml`)

For the open-question shape (`task: answer`, `metric: rubric`) the criteria live
under `scoring.field_metrics.answer.params.criteria`:

```yaml
criteria:
  c1:
    weight: 5
    description: Distingue la tesis del autor de la del comentarista.
    levels: { 0: No lo cumple, 1: Lo cumple }
  c2:
    weight: 3
    description: Sitúa el caso en su contexto histórico y regional.
    levels: { 0: No lo cumple, 1: Lo cumple }
```

- One checkable sentence per criterion. It must be possible to decide *yes* or
  *no* by reading the expert answer. Bad: "Buen nivel de análisis". Good:
  "Menciona al menos dos posiciones y dice en qué se diferencian."
- `weight` is 1–5 and only says how much the criterion moves the score. All
  criteria are applied to every question; a low weight is not "optional".
- Names are `c1`, `c2`, … A new criterion takes the number after the highest
  (`c4` after `c1`–`c3`, even if `c2` was removed). Keep the names stable: the
  app and `review.json` refer to them.
- The app allows one to ten criteria. Fewer, sharper criteria beat ten vague
  ones. If two criteria would always be met together, merge them.
- Derive each criterion from the design: purpose → what must be shown;
  construct → what the answer must do; failureModes → what the answer must not
  do. If a criterion cannot be traced to the design, question it.

## 3. Verify the key, then let the researcher approve

After writing or changing criteria, call `benchy_review("<slug>/benchmark.yaml")`.
The grader applies the rubric to every **expert answer** (the key), not to the
models. An answer that misses a criterion means one of two things:

- the expert answer is incomplete → improve it;
- the criterion is worded too strictly → rewrite it.

Say which, and never mark a question approved yourself: approval is the
researcher's, in the app. A review only counts for the exact rubric it was made
with; after any change, review again.

Then call `benchy_quality("<slug>/benchmark.yaml")` to score the questions
themselves (claridad, relevancia, respaldo, calibre). It informs; it does not
gate approval.

## 4. Multiple choice and closed answers

Multiple-choice benchmarks (`metric: casefold_strip`) and the other closed tasks
are scored by exact match: there is no rubric and no judge. The design still
matters — it says what the questions should probe and what the distractors must
catch — but do not add criteria to their YAML. Say so plainly if the researcher
expects a rubric.

## 5. What to tell the researcher

- "Los criterios no son una lista de temas: son las pruebas que el juez aplica a
  cada respuesta."
- "Verificar la clave es comprobar que la respuesta experta cumple los
  criterios; aprobar la pregunta es una decisión tuya, y viene después."
- "Si cambiás un criterio, hay que volver a verificar todas las claves."
