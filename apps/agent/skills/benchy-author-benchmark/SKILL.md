---
name: benchy-author-benchmark
description: Turn a researcher's question into a benchy benchmark — the program's input/output schema, the scoring weights, the exam (JSONL), and the AI-system to evaluate — written as files in the org workspace and checked with benchy_validate. Use whenever someone wants to measure what AI models know or get wrong in their field.
---
# Author a benchmark

A benchmark is `B = (P, S, D)` — a **program**, a **scoring** function and a
**dataset** (the exam). It is separate from the AI-system that takes it. Your job
is the exam, not the taker. The researcher brings the expertise; you turn it into
something the engine can score, and you ask when their intent is unclear.

## Where files go

Every benchmark is a folder in the org workspace (your file tool's root for
benchmarks is `/opt/data/workspace`):

```
/opt/data/workspace/<slug>/benchmark.yaml
/opt/data/workspace/<slug>/exam.jsonl
```

**The first line of every `benchmark.yaml` is its human-readable name**, as a
comment: `# Corrientes teóricas en etnografía rioplatense`. The app shows it as
the benchmark's title; keep it short and in the researcher's language, and
update it if the benchmark's purpose changes.

Tools take paths **relative to the workspace**: `benchy_validate("<slug>/benchmark.yaml")`.
The workspace is shared by the whole organization — name folders clearly.

## The four questions, in order

**1. What is the program?** A typed contract, `P : X → Y`. Named input fields in,
named output fields out. Write the output first — it is what gets scored.
Types: `string`, `int`, `float`, `bool`, `date`, `time`, `datetime`, a closed
set written `{enum: [a, b, c]}`, and artifacts (`image`, `audio`, `document`). Every field is
required. No lists.

**2. What does "good" mean?** Every output leaf gets exactly one explicit weight
under `scoring.weights`, plus `aggregator: weighted_mean`. Ask "if the model got
only this field wrong, how bad is that?" — the answers are the weights. `0` is a
real choice: validated and reported, but it does not move the score.

**3. What is the exam?** JSONL, one `{"input": {...}, "expected": {...}}` per line,
matching the program exactly. Ten rows is a smoke test; aim for dozens or more.
When the researcher wants help generating rows, draft them, show a few, and let
them correct before writing many.

**4. Task, domain, language.** Closed vocabularies — anything else fails to compile:
`task` is `answer`, `extract`, `classify` or `translate` (`classify` needs exactly
one enum output leaf; `answer` needs `ontology_version: "1.1"`); `language` is `es`, `pt` or `en`; `domain` is one of `general`,
`finance`, `healthcare`, `legal`, `retail`, or an academic field: `anthropology`,
`archaeology`, `sociology`, `history`, `linguistics`, `literature`, `philosophy`,
`political_science`, `economics`, `psychology`, `education`, `geography`,
`communication`, `arts`, `law`, `biology`, `chemistry`, `physics`,
`mathematics`, `computer_science`, `earth_sciences`, `environmental_science`,
`agriculture`, `engineering`, `medicine`, `public_health`. Pick the closest;
use `general` only when none fits.

## Cultural content: run the cultural workflow first

If the benchmark touches cultural axes — knowledge or practices of a specific
community: regional or indigenous traditions, community practices (food, work,
ritual, craft), local language varieties and registers, cultural heritage,
local informal norms — apply `benchy-cultural-benchmark-design` **before
writing exam rows**: its 8-stage workflow runs alongside the four questions,
and its checks (nationality-as-culture, trivia-only, translation-as-substitute,
stereotyped answer keys) produce warnings and a cultural quality score in
`<slug>/cultural-design.md`. Those checks are advisory by design: they never
block the exam — but their warnings must reach the researcher and, later, the
report's `Limitaciones`. Universal disciplinary knowledge (a physics exam, a
national legal code) does not trigger it.

## Open questions: the `answer` task with a rubric (the default for exams)

Most university exams are open questions whose answers a professor grades
against criteria. That is the `answer` task: input `question: string`, output
`answer: string`, and the `answer` field scored by a **rubric** that a grader
model applies to every answer, comparing it with the expert answer in the exam.

Use this shape exactly — the app's question editor and rubric editor read it:

```yaml
# Etnografía andina: reciprocidad y trabajo
version: "1.0"
ontology_version: "1.1"
benchmark: { task: answer, domain: anthropology, language: es }
program:
  input:  { question: string }
  output: { answer: string }
scoring:
  weights: { answer: 1 }
  aggregator: weighted_mean
  field_metrics:
    answer:
      metric: rubric
      params:
        criteria:
          c1:
            weight: 5
            description: Identifica las posiciones o elementos centrales de la respuesta experta.
            levels: { 0: No lo cumple, 1: Lo cumple }
          c2:
            weight: 3
            description: Sitúa el caso en su contexto histórico y regional.
            levels: { 0: No lo cumple, 1: Lo cumple }
  grader: { type: model, provider: bedrock, model: us.moonshotai.kimi-k3 }
data:
  path: ./exam.jsonl
ai-system:
  type: model
  provider: bedrock
  model: us.moonshotai.kimi-k3
  parameters: { temperature: 0, max_tokens: 4096 }
```

- **Criteria** are named `c1`, `c2`, … in order, each with `levels {0: No lo
  cumple, 1: Lo cumple}` and a `weight` from 1 to 5: how important it is. Write
  each `description` as one checkable sentence. The researcher decides how many
  (one to ten: the app allows up to ten, and adds and removes them too); the same
  rubric applies to every question. A new criterion takes the next number after
  the highest (`c4` after `c1`–`c3`, even if `c2` was removed). After any change
  to the rubric, run `benchy_review` again: the app counts a review only for the
  rubric it was made with.
- **Exam rows** are `{"input": {"question": "..."}, "expected": {"answer": "..."}}`:
  the expected answer is the expert answer — the key the grader compares with.
- **Question notes** go in `<slug>/questions.json`, never in the exam (the
  engine rejects extra keys in a row): `{"rows": [{"why": "...", "sources":
  ["..."], "tags": ["..."], "status": "draft", "by": "agente"}]}`, one entry per
  exam row, **in the same order**. `why` says what the question tests; `sources`
  are citations; `status` is `draft` until the researcher approves it in the app
  (`approved`) — never set `approved` yourself. When you add, remove or reorder
  rows, update both files together.
- After writing, call `benchy_review("<slug>/benchmark.yaml")`: the grader grades
  every expert answer with the rubric. An expert answer that misses a criterion is
  a weak key or a criterion worded too strictly; tell the researcher which.
- Call `benchy_quality("<slug>/benchmark.yaml")` too: the grader scores each
  question (not its answer) on four fixed criteria — claridad, relevancia,
  respaldo, calibre — into `quality.json`. A question that misses one is weakly
  asked or unbackable; tell the researcher which, but the score only informs:
  approval is always theirs.

## Questions from the researcher's papers

Researchers add papers to a benchmark from the app (the CONICET library or a PDF
they upload). They are listed in `<slug>/sources.json` — `{"sources": [{"id",
"title", "authors", "year", "file", "pages", "text", ...}]}` — and each one's
text is in `<slug>/<file>` (`sources/<id>.md`): metadata, the abstract, then the
full text with `[p. N]` page markers. `text: "abstract"` means only the abstract
is there (no open PDF, or a scanned one): say so if you use it.

When asked for questions and the benchmark has papers, read the papers first and
write every question from them:

- Each question tests something a specialist would know **from that paper** —
  a finding, an argument, a method and why it was chosen — not trivia (a date,
  a sample size alone) and not something answerable from the title.
- The expert answer is what the paper supports, in your own words, complete
  enough that the grader can check every rubric criterion against it.
- In `questions.json`, `sources` cites the paper by id and page:
  `["conicet-179477 p. 4"]` (`pdf-...` ids for uploads). `why` says what error
  of a model the question exposes. Spread questions across the papers, and
  across groups (`group`) by topic.
- To find papers, search the library with `benchy_library_search` (CONICET
  Digital plus researchers' BICyT records): by `author` for "my papers"
  ("Chávez Martín"), by `query` for a topic. Show the researcher what you
  found (title, year, whether it has an open PDF) and add the ones they pick
  with `benchy_add_paper(bench, id)`. A paper that is not in the library can
  still be uploaded as a PDF from the app's Papers panel.
- Never write questions from memory of a paper you have not read here: if it
  is not in `sources.json`, find and add it first, or ask for the PDF.

## Closed answers: exact match

For the other tasks, a field is right or wrong by exact match, so prefer `enum`,
numbers, dates and short canonical strings:

```yaml
# Conceptos de antropología andina
version: "1.0"
ontology_version: "1.0"
benchmark: { task: classify, domain: anthropology, language: es }
program:
  input:  { question: string }
  output: { answer: { enum: [a, b, c, d] } }
scoring:
  weights: { answer: 1 }
  aggregator: weighted_mean
data:
  path: ./exam.jsonl
ai-system:
  type: model
  provider: bedrock
  model: us.moonshotai.kimi-k3
  parameters: { temperature: 0, max_tokens: 4096 }
```

`benchy_models` lists the models an AI-system may name. To compare models, keep
the benchmark and change only `ai-system` (one file per model is fine).

## Check it

Always call `benchy_validate` after writing or editing the YAML. It rejects and
never repairs: it returns the exact code (`missing_weight`,
`task_program_mismatch`, `invalid_schema`…) and the field path. Fix and validate
again before telling the researcher it is ready. Then use `benchy-run-benchmark`.
