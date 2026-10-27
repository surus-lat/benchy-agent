export interface PeerQuestion {
  bench: string;
  q: number;
  question: string;
  expectedAnswer: string | null;
  votes: { up: number; down: number };
  myVote: number | null;
  hash: string;
  validated: boolean;
  author?: string;
}

// Pure view logic for the Preguntas page (issue #1): group the org's questions
// by benchmark and sort each group with the best-tallied questions first, so
// the members' accumulated score is what leads the list.

export function scoreOf(q: PeerQuestion): number {
  return q.votes.up - q.votes.down;
}

export function keyOf(q: PeerQuestion): string {
  return `${q.bench}#${q.q}`;
}

/** [bench, questions sorted by score desc, ties by question number] per bench,
 *  benches alphabetical. */
export function groupByBench(questions: PeerQuestion[]): readonly (readonly [string, PeerQuestion[]])[] {
  const byBench = new Map<string, PeerQuestion[]>();
  for (const q of questions) {
    const list = byBench.get(q.bench) ?? [];
    list.push(q);
    byBench.set(q.bench, list);
  }
  return [...byBench.entries()]
    .map(([bench, qs]) => [bench, [...qs].sort((a, b) => scoreOf(b) - scoreOf(a) || a.q - b.q)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

export const TRUNCATE_AT = 180;

export function truncate(text: string, at = TRUNCATE_AT): string {
  return text.length > at ? `${text.slice(0, at)}…` : text;
}
