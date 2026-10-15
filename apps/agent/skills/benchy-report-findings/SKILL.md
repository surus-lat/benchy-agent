---
name: benchy-report-findings
description: Analyze a benchmark's results with the researcher and write the findings report (report.md) — what the models get wrong and why, by criterion, topic and paper, with the evidence a paper or a news piece can start from, not just a score. Use when the researcher asks about the results, what they mean, how models compare, or for the report, and whenever they ask to change the report.
---
# Analyze the results and write the findings report

A score is where a finding starts, not the finding. The researcher wants to
know what the models get wrong in their field and why, with evidence they can
publish: an academic paper, a note for the press, a talk.

## The numbers come from benchy_analysis

Call `benchy_analysis("<slug>/benchmark.yaml")` before saying anything about
the results. It reads the newest run of each model and returns:

- `models`: score, `summary` (valid / invalid_outputs / execution_errors),
  `criteria` (share of questions where each rubric criterion was met),
  `groups` (mean score by topic), `papers` (mean score by cited paper), and
  `stale` when the exam changed after that run.
- `criteria`: each criterion's key, weight (importance 1–5) and description.
- `questions`: each question, its expert answer, topic, cited papers, and per
  model the answer, the score and the missed criteria with the grader's
  justification. `hardest` are the questions with the lowest mean.

Quote these numbers; never compute, round differently or remember your own.
Scores are 0–1: write them as they are (0.24) or as a percentage of the
maximum (24%), not as "24 points". If a run is `stale`, say the score is for
an earlier version of the exam. With one run per model and a few dozen
questions, differences of a few hundredths are not findings: say so.

## When the researcher asks about the results

Answer from the analysis, with the evidence: which criterion fails, on which
questions, with a short quote of the model's answer and of the grader's
justification. Look for patterns, not anecdotes: a criterion every model
misses, a topic or a paper where all fail, a confusion that repeats (a term
of art read in its everyday sense, a date or place off, a claim the paper
contradicts), a model that writes fluently and says nothing. Distinguish what
the models do not know from what the rubric or the expert answer may be
measuring badly — the latter is a finding about the exam, worth fixing.

## The report: `<slug>/report.md`

Write it in the researcher's language (Spanish by default), in Markdown, for
a reader who has not seen the platform. The app renders it on the SURUS
letterhead with the organization's name and appends the result tables itself,
so do not paste full tables of every number; cite the ones a finding rests on.

```markdown
# <the main finding, 12 words or fewer — not "Informe de resultados">

## Resumen
- Three bullets: one finding each, one sentence, each with its number.

## Qué se evaluó
The exam (how many questions, from which papers, by whom), the rubric
(criteria and their importance), the models, the grader. One paragraph.

## Resultados
Per model, then per criterion and per topic: what the numbers say, in prose.

## Hallazgos
### <finding>
What happens, how often, on which questions. The evidence: the question, a
short quote of the expert answer and of the model's, the criterion missed and
why (the grader's justification). Two to four findings.

## Limitaciones
Number of questions, one run per model, temperature, a grader not yet
calibrated against a professor, papers with only their abstract.

## Para publicar
The angle for a paper and the angle for a news piece, and what to add before
publishing (more questions, more models, a professor grading a sample).
```

The title is a headline, not a summary: it goes in large type on the
letterhead, so keep it to one line or two. Cite questions by number
("pregunta 03") and papers by title. Do not invent quotes: copy them from
the analysis.

## Changing the report

When the researcher asks for a change — a finding to add or drop, a different
title, a paragraph for the press — edit `report.md` in place (keep what they
did not ask to change) and say in one line what changed. The app reloads it.
