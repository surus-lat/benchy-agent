---
name: benchy-run-benchmark
description: Run a benchy benchmark against an AI model with benchy_run and explain the result correctly — what valid, invalid_output and execution_error mean, why the score is what it is, and what to change. Use after a benchmark validates and the researcher wants to evaluate a model.
---
# Run a benchmark and read the result

`benchy_run("<slug>/benchmark.yaml")` runs the exam against the benchmark's
`ai-system` (one model call per row — tell the researcher it may take a few
minutes for a large exam) and saves the full result under `<slug>/runs/`.

## Read the summary first

```json
{"benchmark_score": 0.81,
 "summary": {"examples": 40, "valid": 38, "invalid_outputs": 2, "execution_errors": 0}}
```

**If `valid` is not equal to `examples`, explain the failures before the score.**
A score over mostly-failed examples is not a measurement of knowledge.

| status | what happened | what to do |
|---|---|---|
| `valid` | a schema-valid answer, whatever it scored | nothing — a valid 0 is the model being wrong, which is the finding |
| `invalid_output` | it answered something that is not a program output | read `prediction`; often a string where a number was required, or truncated JSON |
| `execution_error` | it never answered | read `error.message`: throttling, a token budget, or a model that is not available |

Both failure kinds count as 0, so they never vanish from the mean.

## Explaining a score

Per-example `field_scores` show which fields were right and their weights. A low
score with most fields right usually means the heavily weighted field was wrong —
that is the weights working. If that feels wrong to the researcher, the weights
are what to revisit, not the engine.

## Rubric benchmarks

An `answer` benchmark is graded by its `scoring.grader`: each valid answer's
`field_scores` entry keeps `criteria`, every criterion's grade and
justification. Explain a low score with those justifications, criterion by
criterion. The result also records the grader (`grader.system`). Scores are
only comparable under the same grader and the same rubric. A run costs one
model call plus two grader calls per question (the grader also grades the empty
answer, the baseline). `grader_error` aborts the run: the grader replied outside
the rubric — run again, and if it repeats, tell the researcher.

## Common fixes

- Everything `invalid_output` with cut-off JSON → raise `max_tokens` in `ai-system.parameters`.
- `wrong_type` on a number → the model answered `"12.0"`; the engine does not coerce, on purpose.
- `adapter_not_bound` naming a model → pick one from `benchy_models`.

## Comparing models

Same benchmark, different `ai-system` blocks, one run each; report the scores
side by side with the failure counts. Differences on small exams are noisy — say so.
