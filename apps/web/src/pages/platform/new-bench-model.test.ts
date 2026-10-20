import { expect, it } from "vitest";
import { benchmarkYaml, slugify, togglePaper, uniqueSlug, type PickedPaper } from "./new-bench-model";
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

it("the picked bibliography keeps each paper once and toggles it in and out", () => {
  const a: PickedPaper = { id: 1, title: "Morfología verbal del mapudungun", creators: ["Pérez, M."], year: 2019 };
  const b: PickedPaper = { id: 2, title: "Corrientes teóricas en etnografía", creators: [], year: null };
  // Picking adds, in order, without dropping what was already picked.
  expect(togglePaper([], a)).toEqual([a]);
  expect(togglePaper([a], b).map((p) => p.id)).toEqual([1, 2]);
  // Picking the same paper again takes it out: it is never twice in the list.
  expect(togglePaper([a, b], a).map((p) => p.id)).toEqual([2]);
  expect(togglePaper([a], a)).toEqual([]);
});
