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
`task` is `extract`, `classify` or `translate` (`classify` needs exactly one enum
output leaf); `language` is `es`, `pt` or `en`; `domain` is one of `general`,
`finance`, `healthcare`, `legal`, `retail`, or an academic field: `anthropology`,
`archaeology`, `sociology`, `history`, `linguistics`, `literature`, `philosophy`,
`political_science`, `economics`, `psychology`, `education`, `geography`,
`communication`, `arts`, `law`, `biology`, `chemistry`, `physics`,
`mathematics`, `computer_science`, `earth_sciences`, `environmental_science`,
`agriculture`, `engineering`, `medicine`, `public_health`. Pick the closest;
use `general` only when none fits.

## Exact match is the scoring rule

Field correctness is exact match. A free-text `string` answer is right or wrong
with nothing in between — so prefer `enum`, numbers, dates and short canonical
strings. If the researcher's real question has a paragraph as its answer, say so
plainly and help them reframe it as decisions the model must get right (e.g. one
`enum` or `bool` per rubric criterion).

## The skeleton

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
  parameters: { temperature: 0, max_tokens: 2048 }
```

`benchy_models` lists the models an AI-system may name. To compare models, keep
the benchmark and change only `ai-system` (one file per model is fine).

## Check it

Always call `benchy_validate` after writing or editing the YAML. It rejects and
never repairs: it returns the exact code (`missing_weight`,
`task_program_mismatch`, `invalid_schema`…) and the field path. Fix and validate
again before telling the researcher it is ready. Then use `benchy-run-benchmark`.
