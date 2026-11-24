import type { Analysis } from "./data";

export type Recovery = { message: string; label: string; target: "evaluation" | "questions" | "judge" | "catalog" | "status" };

export function evaluationRecovery(code?: string): Recovery {
  switch (code) {
    case "busy": case "EVALUATION_RUNNING": case "AGENT_TIMEOUT": return { message: "Puede haber una corrida en curso. Actualizá el estado antes de volver a ejecutar.", label: "Actualizar estado", target: "status" };
    case "invalid_dataset_record": case "invalid_dataset": return { message: "El archivo del examen tiene preguntas o respuestas con formato inválido. Corregilo antes de volver a evaluar.", label: "Abrir preguntas", target: "questions" };
    case "global_models_required": return { message: "La selección incluye un modelo sin perfil global. Actualizá el catálogo y elegí uno habilitado.", label: "Actualizar modelos", target: "catalog" };
    case "empty_exam": return { message: "El examen no tiene preguntas. Agregá al menos una antes de evaluar.", label: "Abrir preguntas", target: "questions" };
    case "dataset_too_large": return { message: "El examen supera el máximo admitido. Reducilo o dividilo antes de evaluar.", label: "Abrir preguntas", target: "questions" };
    case "data_not_found": return { message: "No se encontró el examen. Revisá su archivo y las preguntas.", label: "Abrir preguntas", target: "questions" };
    case "exam_changed": return { message: "El resultado corresponde a otra versión del examen o no se pudo verificar la versión. Volvé a correr los modelos con el examen actual.", label: "Preparar evaluación actual", target: "evaluation" };
    case "no_runs": return { message: "El informe necesita resultados. Ejecutá una evaluación primero.", label: "Ir a Evaluación", target: "evaluation" };
    case "access_denied": case "model_not_available": return { message: "El proveedor no permitió usar este modelo. Actualizá el catálogo; si debería aparecer, pedile al administrador que revise los permisos.", label: "Revisar catálogo", target: "catalog" };
    case "unsupported_model": return { message: "Este modelo no está disponible para evaluar. Elegí otro del catálogo.", label: "Elegir modelos", target: "evaluation" };
    case "grader_error": return { message: "El juez no pudo calificar. Revisá el juez y corré juntos los modelos que querés comparar.", label: "Revisar juez", target: "judge" };
    case "no_valid_results": return { message: "No hubo respuestas válidas para puntuar. Revisá los modelos y el juez antes de volver a evaluar.", label: "Preparar nueva evaluación", target: "evaluation" };
    case "timeout": return { message: "La operación superó el tiempo de espera. Revisá la selección y probá con menos modelos si se repite.", label: "Revisar evaluación", target: "evaluation" };
    default: return { message: "No se pudo completar la operación. Revisá la configuración y volvé a intentar. Si se repite, compartí el detalle técnico con tu administrador.", label: "Revisar evaluación", target: "evaluation" };
  }
}

export function resultRecoveries(model: Pick<Analysis["models"][number], "latest_error" | "stale" | "summary">): Recovery[] {
  const out: Recovery[] = [];
  if (model.latest_error) out.push(evaluationRecovery(model.latest_error.code));
  if (model.stale && model.latest_error?.code !== "exam_changed") out.push(evaluationRecovery("exam_changed"));
  const { valid, examples } = model.summary;
  if (!model.latest_error && !model.stale && valid != null && examples != null && valid < examples) {
    out.push({ message: `Solo ${valid} de ${examples} respuestas fueron válidas. El modelo queda fuera del ranking. ${model.summary.invalid_outputs ? "Revisá el formato esperado o elegí otro modelo antes de volver a evaluar." : "Revisá el proveedor y el juez antes de volver a evaluar."}`, label: "Preparar nueva evaluación", target: "evaluation" });
  }
  return out;
}
