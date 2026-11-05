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
<workspace>/<slug>/design.json      what we want to find out (both edit it)
<workspace>/<slug>/benchmark.yaml   the rubric the judge applies
```

The workspace root varies per deployment (e.g. `/opt/data/workspace/` in the
hosted app, `<hermes-home>/workspace/` locally). Don't hardcode it: if a
workspace path fails to read, locate the slug with a file search for
`benchmark.yaml` under the user home before concluding the benchmark is missing.

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
- `weight` is 1–5 and only matters as a *proportion*: the app shows each
  criterion as a share of the final score (weight 3 of 5/3/2 → 30%). All five
  criteria at 5 is the same exam as all at 1, so never leave them all at the
  top — spread them to say what actually matters more. Every criterion is
  applied to every question; a low weight is not "optional".
- Names are `c1`, `c2`, … A new criterion takes the number after the highest
  (`c4` after `c1`–`c3`, even if `c2` was removed). Keep the names stable: the
  app and `review.json` refer to them.
- The app allows one to ten criteria. Fewer, sharper criteria beat ten vague
  ones. If two criteria would always be met together, merge them.
- The researcher can delete every criterion and leave `criteria` empty. The
  engine still validates that file, so it is the app that blocks evaluating and
  publishing until there is at least one — never "fix" an empty rubric by
  leaving it empty, and never write it empty yourself.
- Derive each criterion from the design: purpose → what must be shown;
  construct → what the answer must do; failureModes → what the answer must not
  do. If a criterion cannot be traced to the design, question it. The reverse
  coverage also must hold: every declared failureMode needs at least one
  criterion that catches it. A bias failureMode (substituting another
  language/region/tradition for the one asked) needs a *negative* criterion —
  "no atribuye X a otra lengua/región" — because positive criteria never expose
  substitution.

### Auditing existing criteria against the design

When the researcher asks you to check whether the criteria are checkable and
what is missing:

- Take each description in turn and ask: could the judge decide sí/no by
  reading the model answer against the expert answer, without inventing what
  counts? If not, rewrite the description to name the concrete claim, term or
  attribution to compare — keep the criterion name and tune the weight, don't
  renumber.
- If the researcher rewrote `design.json` to a new topic, look for template
  leftovers from the old one: criterion wording that references the previous
  domain's notions ("autores, período" in a linguistics design) and a stale
  `domain:` in the `benchmark:` header. Propose fixing the header metadata
  together with the criteria.
- Split criteria that mix distinct failure modes into separate ones (e.g.
  contradicting the key vs inventing sources/etymologies) — they catch
  different errors and the model that commits only one should fail only one.
- If the exam file is still empty, say plainly that the audit can only judge
  wording, not the keys; `benchy_review` verification happens once questions
  with expert answers exist.

## 3. Verify the key, then let the researcher approve

After writing or changing criteria, call `benchy_review("<slug>/benchmark.yaml")`
(pass the slug-relative path; the tool resolves the workspace root itself).
The grader applies the rubric to every **expert answer** (the key), not to the
models. An answer that misses a criterion means one of two things:

- the expert answer is incomplete → improve it;
- the criterion is worded too strictly → rewrite it.

Say which, and never mark a question approved yourself: approval is the
researcher's, in the app. A review only counts for the exact rubric it was made
with; after any change, review again.

- If `benchy_review` (or a run) fails with `adapter_not_bound` / "AWS_REGION is
  not set", the bedrock grader or AI-system needs the AWS region exported in the
  engine's environment — get it set, or have the researcher run the review from
  the app, which carries its own config, and re-run after any rubric change.
  Report the blocker plainly; never substitute your own manual grading for
  review results.

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
