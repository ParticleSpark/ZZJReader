import { expect, it } from "vitest";
import type { Annotation } from "@reader/core";
import {
  activeAnnotation,
  annotationContext,
  applySavedAnnotation,
  documentOrder,
} from "./annotations";
const a: Annotation = {
  id: "a",
  documentId: "doc",
  kind: "underline",
  location: { type: "pdf", page: 1 },
  quote: "one two",
  note: "",
  color: "",
  createdAt: "",
};
it("replaces a merged underline in place and removes only superseded IDs", () => {
  const note = { ...a, id: "note", kind: "note" as const, note: "Keep this" };
  const result = applySavedAnnotation(
    [a, note, { ...a, id: "b", quote: "two three" }],
    { ...a, quote: "one two three", replacedIds: ["b"] },
  );
  expect(result.map((item) => item.id)).toEqual(["a", "note"]);
  expect(result[0].quote).toBe("one two three");
  expect(result[1]).toBe(note);
  expect(result[0]).not.toHaveProperty("replacedIds");
  expect(
    applySavedAnnotation(result, { ...a, quote: "one two three" }),
  ).toEqual(result);
});
it("edits an existing note when several annotation kinds cover a passage", () => {
  const note = { ...a, id: "note", kind: "note" as const, note: "Keep this" };
  expect(activeAnnotation([a, note], [a.id, note.id])).toBe(note);
  expect(activeAnnotation([a, note], [a.id])).toBe(a);
});
it("orders analysis marks by saved version and offsets after the original document", () => {
  const analysis = (
    id: string,
    hash: string,
    start: number,
    end: number,
  ): Annotation => ({
    ...a,
    id,
    location: {
      type: "method-analysis",
      contentHash: hash.repeat(64),
      start,
      end,
    },
  });
  const marks = [
    analysis("new-version", "b", 0, 10),
    analysis("later", "a", 40, 50),
    analysis("longer", "a", 0, 30),
    { ...a, id: "paper", createdAt: "2026-10-20" },
    analysis("shorter", "a", 0, 10),
  ];
  expect([...marks].sort(documentOrder).map((mark) => mark.id)).toEqual([
    "paper",
    "shorter",
    "longer",
    "later",
    "new-version",
  ]);
});
it("identifies analysis annotations as AI interpretations in chat context", () => {
  const text = annotationContext([
    {
      ...a,
      id: "analysis",
      quote: "An interpretation of the optimization loop.",
      note: "Verify the equation.",
      location: {
        type: "method-analysis",
        contentHash: "a".repeat(64),
        start: 0,
        end: 45,
      },
    },
    a,
  ]);
  expect(text).toContain("- 第 1 页：“one two”");
  expect(text).toContain(
    "- 方法解析（AI生成解读，非论文原文）：“An interpretation of the optimization loop.” —— 批注：Verify the equation.",
  );
  expect(text.indexOf("one two")).toBeLessThan(
    text.indexOf("An interpretation"),
  );
});
