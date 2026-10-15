import { expect, it } from "vitest";
import { benchmarkYaml, slugify, uniqueSlug } from "./new-bench-model";
import { isOpenQuestionExam, parseBenchDoc, readCriteria } from "./exam-model";
import { readBenchYaml } from "./data";

it("makes a folder name from the benchmark's name", () => {
  expect(slugify("Morfología del mapudungun: sufijos verbales")).toBe("morfologia-del-mapudungun-sufijos-verbales");
  expect(slugify("  Ñandú y ciervo   ")).toBe("nandu-y-ciervo");
  expect(slugify("Corrientes teóricas en etnografía rioplatense del siglo veinte y sus discípulos")).toBe(
    "corrientes-teoricas-en-etnografia-rioplatense",
  );
  expect(slugify("¿¡!?")).toBe("benchmark");
});

it("never reuses a folder that exists", () => {
  expect(uniqueSlug("lenguas", new Set(["otra"]))).toBe("lenguas");
  expect(uniqueSlug("lenguas", new Set(["lenguas", "lenguas-2"]))).toBe("lenguas-3");
});

it("writes a benchmark the editors read as an open-question exam with its rubric", () => {
  const text = benchmarkYaml("Morfología del mapudungun:\n sufijos", "linguistics", "es");
  const doc = readBenchYaml(text, "morfologia");
  expect(doc.title).toBe("Morfología del mapudungun: sufijos");
  expect(doc.task).toBe("answer");
  expect(doc.domain).toBe("linguistics");
  const criteria = readCriteria(parseBenchDoc(text));
  expect(criteria?.map((c) => [c.key, c.weight])).toEqual([
    ["c1", 5],
    ["c2", 3],
    ["c3", 2],
  ]);
  expect(isOpenQuestionExam(doc.task, criteria)).toBe(true);
});
