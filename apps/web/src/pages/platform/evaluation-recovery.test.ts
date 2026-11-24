import { describe, expect, it } from "vitest";
import { evaluationRecovery, resultRecoveries } from "./evaluation-recovery";

describe("recuperación de evaluación", () => {
  it.each([
    ["empty_exam", "questions"], ["dataset_too_large", "questions"],
    ["exam_changed", "evaluation"], ["no_valid_results", "evaluation"],
    ["no_runs", "evaluation"], ["unsupported_model", "evaluation"],
    ["access_denied", "catalog"], ["grader_error", "judge"],
    ["timeout", "evaluation"], ["future_error", "evaluation"],
    ["EVALUATION_RUNNING", "status"], ["AGENT_TIMEOUT", "status"],
    ["global_models_required", "catalog"], ["invalid_dataset_record", "questions"],
  ])("ofrece una salida para %s", (code, target) => {
    expect(evaluationRecovery(code)).toMatchObject({ target, label: expect.any(String), message: expect.any(String) });
  });
  it("mantiene la acción del error de la última corrida aunque exista una anterior", () => {
    expect(resultRecoveries({ latest_error: { code: "empty_exam", message: "" }, stale: true, summary: { examples: 4, valid: 4 } }).map(r => r.target)).toEqual(["questions", "evaluation"]);
  });
  it("distingue cobertura incompleta de un cero válido", () => {
    expect(resultRecoveries({ stale: false, latest_error: null, summary: { examples: 4, valid: 2 } })[0].message).toContain("2 de 4");
    expect(resultRecoveries({ stale: false, latest_error: null, summary: { examples: 4, valid: 4 } })).toEqual([]);
  });
});
