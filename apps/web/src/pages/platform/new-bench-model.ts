// A new benchmark, made by the app without the agent: the wizard asks only
// for the benchmark itself — the folder, a benchmark.yaml for open questions
// with a starting rubric, an empty exam and its notes — and the researcher
// lands in 01 · Fuentes to curate the bibliography (the papers and
// publications the questions are written from). The agent is there in B if
// they want it, never in the way.

/** The engine's academic domains (its closed vocabulary), with their names in Spanish. */
export const DOMAINS: [string, string][] = [
  ["agriculture", "Agronomía"],
  ["anthropology", "Antropología"],
  ["archaeology", "Arqueología"],
  ["arts", "Artes"],
  ["biology", "Biología"],
  ["political_science", "Ciencia política"],
  ["environmental_science", "Ciencias ambientales"],
  ["computer_science", "Ciencias de la computación"],
  ["earth_sciences", "Ciencias de la Tierra"],
  ["communication", "Comunicación"],
  ["law", "Derecho"],
  ["economics", "Economía"],
  ["education", "Educación"],
  ["philosophy", "Filosofía"],
  ["physics", "Física"],
  ["geography", "Geografía"],
  ["history", "Historia"],
  ["engineering", "Ingeniería"],
  ["linguistics", "Lingüística"],
  ["literature", "Literatura"],
  ["mathematics", "Matemática"],
  ["medicine", "Medicina"],
  ["psychology", "Psicología"],
  ["chemistry", "Química"],
  ["public_health", "Salud pública"],
  ["sociology", "Sociología"],
  ["general", "Otra / general"],
];

export const LANGUAGES: [string, string][] = [
  ["es", "Español"],
  ["pt", "Português"],
  ["en", "English"],
];

/** A paper picked from the library: what the chosen list shows. hasPdf tells the benchmark's pending note whether the agent reads the full text or just the abstract. */
export type PickedPaper = { id: number; title: string; creators: string[]; year: number | null; hasPdf?: boolean };

/** A picked bibliography (the benchmark's Fuentes, via the shared picker): a paper toggles in or out of the list and is never in it twice. */
export function togglePaper(list: PickedPaper[], paper: PickedPaper): PickedPaper[] {
  return list.some((p) => p.id === paper.id) ? list.filter((p) => p.id !== paper.id) : [...list, paper];
}

/** A folder name from the benchmark's name: lowercase ASCII words joined by hyphens. */
export function slugify(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 48) break;
    slug = next;
  }
  return slug || words[0]?.slice(0, 48) || "benchmark";
}

/** The slug, or the slug with -2, -3… when a folder by that name already exists. */
export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The criteria a new benchmark starts with; the researcher edits them in Rúbrica. */
const CRITERIA: [number, string][] = [
  [5, "Identifica las ideas centrales de la respuesta experta."],
  [3, "No afirma nada que contradiga la respuesta experta ni inventa datos, autores o fuentes."],
  [2, "Sitúa la respuesta en su contexto (autores, período, lugar) como lo hace la respuesta experta."],
];

const MODEL = "us.moonshotai.kimi-k3";

/** benchmark.yaml for an open-question exam graded with a rubric (the shape the editors read). */
export function benchmarkYaml(title: string, domain: string, language: string): string {
  const name = title.replace(/\s+/g, " ").trim();
  const criteria = CRITERIA.map(
    ([weight, description], i) =>
      `          c${i + 1}:\n            weight: ${weight}\n            description: ${JSON.stringify(description)}\n            levels: { 0: No lo cumple, 1: Lo cumple }`,
  ).join("\n");
  return `# ${name}
version: "1.0"
ontology_version: "1.1"
benchmark: { task: answer, domain: ${domain}, language: ${language} }
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
${criteria}
  grader: { type: model, provider: bedrock, model: ${MODEL} }
data:
  path: ./exam.jsonl
ai-system:
  type: model
  provider: bedrock
  model: ${MODEL}
  parameters: { temperature: 0, max_tokens: 4096 }
`;
}
