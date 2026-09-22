import { execFileSync } from "node:child_process";

export const DB_NAME = "benchy-db";

export function d1Execute(sql: string): unknown {
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB_NAME, "--remote", "--json", "--command", sql],
    // stdin/stderr inherited so that a wrangler confirmation prompt is visible
    // and answerable instead of hanging on a captured pipe.
    { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"] },
  );
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(
      `Could not parse "wrangler d1 execute" output as JSON.\n\nRaw output:\n${output}`,
    );
  }
}

/**
 * Pulls the `results` array out of a `wrangler d1 execute --json` response
 * defensively: if the shape is not `Array<{ results: [...] }>`, fail loudly
 * with the raw response instead of an opaque "undefined is not an object".
 */
export function extractResultRows(
  raw: unknown,
  context: string,
): Array<Record<string, unknown>> {
  const fail = (): never => {
    throw new Error(
      `Unexpected response shape from "wrangler d1 execute" while ${context}.\n` +
        `Expected an array with a "results" array in its first element.\n\n` +
        `Raw parsed output:\n${JSON.stringify(raw, null, 2)}`,
    );
  };

  if (!Array.isArray(raw) || raw.length === 0) fail();
  const first = (raw as unknown[])[0];
  if (typeof first !== "object" || first === null) fail();
  const { results } = first as { results?: unknown };
  if (!Array.isArray(results)) fail();
  return results as Array<Record<string, unknown>>;
}
