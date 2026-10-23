---
name: benchy-cultural-benchmark-design
description: Design a culturally grounded benchmark — one that measures knowledge or practices of a specific human community — with an 8-stage workflow, four anti-pattern detectors and a 15-dimension cultural quality score, all advisory by design — they lower the score and write explicit warnings, never block the exam. Use when a benchmark to create or edit touches cultural axes (regional or indigenous traditions, community practices, local language varieties and registers, cultural heritage, local informal norms), before writing exam rows.
---
# Design a culturally grounded benchmark

Universities use benchy to measure what AI models know about *their* culture —
local knowledge, practices, language varieties. A benchmark about culture can
be wrong in ways `benchy_validate` cannot see: it compiles, and it still
reduces a living culture to trivia, to stereotypes, or to a country's flag.
This skill is the cultural review that runs alongside `benchy-author-benchmark`:
an 8-stage workflow, four anti-pattern detectors, and a 15-dimension quality
score, ported from SURUS's `cultural-benchmark-design` and adapted to the
benchy tool contract.

## The one rule: advisory, never blocking

Every gate, anti-pattern and score in this skill is **advisory**. No failed
check ever stops you from writing or editing the exam, ever refuses a
`benchy_validate` or a `benchy_run`, and ever tells the researcher they cannot
proceed. A failed check does exactly two things:

1. lowers the affected dimensions of the cultural quality score, and
2. adds an explicit, named warning — in `<slug>/cultural-design.md`, in your
   reply to the researcher, and later in the findings report's `Limitaciones`.

The researcher decides; you inform, with specifics. `benchy_validate` remains
the only structural gate, and this skill changes nothing about it. Do not
soften this rule and do not strengthen it: warnings that block would make the
agent a censor over someone else's culture; checks without teeth would make
this skill decoration.

## When it applies

Apply it when the benchmark touches cultural axes — knowledge or practices of
a specific human community: regional or indigenous traditions, community
practices (food, work, ritual, craft), local language varieties and registers,
cultural heritage, local institutions and their informal norms. A benchmark of
universal disciplinary knowledge (a physics exam, a national legal code) does
not need it. When in doubt, apply it — with little cultural content the
workflow degrades to a short note, not to overhead.

## What you work with

Your tools are the file tool rooted at `/opt/data/workspace` and the benchy
MCP: `benchy_validate`, `benchy_run`, `benchy_models`. There is no terminal
and no web access in this container. Everything this workflow produces lives
in one file next to the exam:

```
/opt/data/workspace/<slug>/cultural-design.md
```

Write it in the researcher's language (Spanish by default), and keep it
current as the exam evolves.

## The 8 stages

### 1. Scope the construct

Name the cultural capability the benchmark measures, as observable behavior.
Vague goals ("conocimiento de la cultura rioplatense") get decomposed: what
does a model that *has* this capability do that one without it does not?
Write, in `cultural-design.md`: the construct, what counts as a good answer,
what counts as failure, and the exclusions — what the exam does **not**
measure. *Check (advisory):* a construct that stays vague after one round of
questions to the researcher is warning W-CONSTRUCT.

### 2. Map communities and their variation

Name the communities the content is about — by practice, region or language
variety, never by passport alone. For each, name at least two dimensions of
internal variation (region, age cohort, register, urban/rural, migration
history), because the exam must sample that variation, not one voice of it.
Governance, simplified for a university: the community's interface is the org
itself, so require exactly one thing — a **named second reader** with
first-hand knowledge of the community (a colleague, a collaborator, a member)
who reviews the exam before its scores are presented as cultural ground
truth. *Check (advisory):* a community defined only by a nationality trips
anti-pattern AP-1; no second reader named is warning W-READER.

### 3. Design the tasks

Decide what a question looks like. Situated and applied questions — a
scenario, a judgment call, explaining a practice in its context — measure
cultural capability. Pure recall (a date, a name, a definition) measures
trivia. Trivia questions are allowed; an exam where they are the whole
measurement trips AP-2.

### 4. Data and language

Decide where questions come from: the researcher's papers (cited in
`questions.json`), the researcher's own expertise, community documents. And
decide the language: items written in the community's own language or variety
are grounded; items drafted in another language and translated in are a
shortcut — fine for a translation benchmark, a substitute everywhere else
(AP-3). Never invent cultural facts: you structure, the researcher testifies.
A cultural claim with no source is labeled `PENDIENTE DE VALIDACIÓN` in
`questions.json`'s `why`, not stated as fact.

### 5. Judgment: the rubric and the expert answers

The exam's expert answers are the answer key, and the rubric grades against
them. If a key rewards a stereotype, or a criterion is worded so that only
one regional variant of a correct answer passes, the benchmark teaches the
stereotype (AP-4) and punishes the variation Stage 2 mapped. Write keys that
name acceptable variation explicitly ("también es válido: …").

### 6. Metrics

Write down what a run's numbers capture and what they hide. The score per
criterion and per topic is real evidence; within-community variation, register
fit, and disagreement among experts are invisible to it. One line each,
captures and hides, in `cultural-design.md`.

### 7. Validate — structure and culture

`benchy_validate("<slug>/benchmark.yaml")` for structure, as always. Then the
cultural audit: run the four anti-pattern detectors below over the exam, the
rubric and the expert answers, and score the 15 dimensions. Both kinds of
findings are reported; neither blocks.

### 8. Pilot

Pick at least one model from `benchy_models` and pilot with
`benchy_run("<slug>/benchmark.yaml")`. Read the result with the cultural
lens: a model placing a local case in another country's institutions, using
another country's terms, or answering fluently with stereotypes is exactly the
finding these benchmarks exist to capture. Update the score profile and the
warnings with what the run showed.

## The four anti-patterns — detect, penalize, warn, never block

| id | anti-pattern | what it looks like | dimensions it caps at 1/4 |
|---|---|---|---|
| AP-1 | **nationality-as-culture** | the "culture" under test is a country: communities defined by nationality with no regional, linguistic or practice dimension | 2 · community definition, 3 · within-community variation |
| AP-2 | **trivia-only** | every item is pure factual recall — dates, names, definitions — on a benchmark that claims to measure cultural knowledge or practices | 4 · task realism, 14 · contamination & memorization |
| AP-3 | **translation-as-substitute** | items drafted in another language and translated in, presented as culturally grounded content | 5 · source grounding, 6 · language grounding |
| AP-4 | **stereotyped answer keys** | expert answers or rubric criteria reward group-stereotypical content, or penalize legitimate within-community variation | 7 · answer-key quality, 8 · rubric fitness, 12 · bias audit |

A detection **caps** the named dimensions at 1/4 and produces a warning named
after the pattern, written in `cultural-design.md` and told to the researcher
in the same reply — what was found, on which questions, and what would fix it.
The exam still ships if the researcher wants it to.

**Worked example — a trivia-only benchmark.** An exam "Cultura guaraní" of 30
questions, every one recall ("¿En qué año…?", "¿Cómo se llama…?"), nothing
situated or applied. AP-2 fires:

```
ADVERTENCIA AP-2 (benchmark de pura trivia): las 30 preguntas son de
recuerdo factual; ninguna mide conocimiento cultural situado ni prácticas.
Efecto: dimensiones 4 (realismo de tareas) y 14 (contaminación/memorización)
limitadas a 1/4. El examen se genera igual; para levantar la advertencia,
convertí al menos una parte de las preguntas en escenarios aplicados
(una situación, un juicio, una práctica explicada en contexto).
```

## The 15-dimension cultural quality score

Score each dimension 0–4 with a one-line evidence note after Stage 7; update
after the pilot. Report the profile, never one opaque number — if you mention
the average, say that the capped and low dimensions dominate it.

1. **Construct definition** — decomposed into observable behavior, exclusions named
2. **Community definition** — communities by practice/region/language, not nationality
3. **Within-community variation** — ≥2 internal variation dimensions per community, sampled by the items
4. **Task realism** — situated/applied items exist; recall is not the whole exam
5. **Source grounding** — questions traceable to papers or named expertise, nothing from model memory alone
6. **Language grounding** — items authored in the community's language or variety, not translated in
7. **Answer-key quality** — expert answers free of stereotypes, acceptable variation named
8. **Rubric fitness** — criteria checkable and about cultural content, not surface form
9. **Ambiguity & disagreement handling** — ambiguous-by-design items noted; expert disagreement preserved, never silently averaged
10. **Second-reader coverage** — a named community-knowledgeable reader beyond the author
11. **Metrics honesty** — what the score captures and hides, written down
12. **Bias & stereotype audit** — the explicit pass over the items was done and recorded
13. **Grader awareness** — the rubric grader is a model never calibrated against a professor; its cultural judgments are provisional, and the exam says so
14. **Contamination & memorization** — items not answerable from generic web trivia alone
15. **Documentation** — `cultural-design.md` complete; every cultural claim labeled finding, source, or `PENDIENTE DE VALIDACIÓN`

Readiness label, for the researcher's information only: **sin observaciones**
(no warnings, no dimension under 2), **con observaciones** (warnings or low
dimensions present, each named), **revisión cultural recomendada** (any
anti-pattern detected). The label gates nothing.

## What goes in `cultural-design.md`

```markdown
# Diseño cultural — <benchmark name>
## Constructo y alcance            (stage 1)
## Comunidades y variación         (stage 2, second reader named here)
## Diseño de tareas y datos        (stages 3–4)
## Criterios de evaluación y respuestas experta    (stage 5)
## Qué mide y qué oculta el score  (stage 6)
## Advertencias                    (AP-*, W-*; "ninguna" if none)
## Perfil de calidad cultural      (15 dimensions, score + evidence each)
## Piloto                          (stage 8: model, run date, what it showed)
```

## What goes in the findings report

When `report.md` is written (`benchy-report-findings`), the cultural warnings
and the dimensions under 2 belong in its `Limitaciones`, named and verbatim
enough that a reader can act on them — they are part of what the benchmark's
scores mean.
