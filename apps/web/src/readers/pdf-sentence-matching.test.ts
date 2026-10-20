import { expect, it } from "vitest";
import { sentenceTextRanges } from "./pdf-sentence-matching";

const normalized = (s: string) => s.toLowerCase().replace(/\s/g, "");
const source = normalized(
  "Each time 𝑡 merges a 𝑖 record-local graph, it checks all followers.",
);
const pdf = normalized(
  "Each time 𝑡𝑖 merges a record-local graph, it checks all followers.",
);

it("keeps reordered subscripts in the full PDF sentence range", () => {
  const text = "preceding." + pdf + "following.";
  expect(sentenceTextRanges(text, source, [source])).toEqual([
    { start: 10, end: 10 + pdf.length },
  ]);
});

it("does not accept different prose or different mathematical variables", () => {
  expect(
    sentenceTextRanges(pdf.replace("allfollowers", "nofollowers"), source, [
      source,
    ]),
  ).toEqual([]);
  expect(sentenceTextRanges(pdf.replace("𝑖", "𝑗"), source, [source])).toEqual(
    [],
  );
  expect(
    sentenceTextRanges("𝑡𝑖=1.", "Unrelated paragraph.", ["𝑡=1𝑖."]),
  ).toEqual([]);
});

it("uses the full paragraph when OCR moves a subscript across a sentence boundary", () => {
  const first = normalized(
    "Each time 𝑡 merges a record-local graph, it checks all followers.",
  );
  const second = normalized(
    "𝑖 The transaction checks every record before committing.",
  );
  const actualSecond = normalized(
    "The transaction checks every record before committing.",
  );
  const text = pdf + actualSecond;
  expect(sentenceTextRanges(text, first + second, [first, second])).toEqual([
    { start: 0, end: pdf.length },
    { start: pdf.length, end: text.length },
  ]);
});

it("rejects ambiguous prose without paragraph context and resolves it with source order", () => {
  const paragraph = source + source;
  const text = pdf + pdf;
  expect(sentenceTextRanges(text, "Unrelated paragraph.", [source])).toEqual(
    [],
  );
  expect(sentenceTextRanges(text, paragraph, [source], source.length)).toEqual([
    { start: pdf.length, end: pdf.length * 2 },
  ]);
});

it("moves only geometrically identified script tokens while preserving every prose character", () => {
  const block = normalized(
    "We choose candidate Π with consistent evidence Φ across every evaluation.",
  );
  const text = normalized(
    "We choose candidate ΠΦ with consistent evidence across every evaluation.",
  );
  const start = text.indexOf("φ");
  const scripts = [{ start, end: start + 1 }];
  expect(sentenceTextRanges(text, block, [block], 0, scripts)).toEqual([
    { start: 0, end: text.length },
  ]);
  expect(sentenceTextRanges(text, block, [block])).toEqual([]);
  expect(
    sentenceTextRanges(text.replace("φ", "ψ"), block, [block], 0, scripts),
  ).toEqual([]);
  expect(
    sentenceTextRanges(
      text.replace("consistent", "conflicting"),
      block,
      [block],
      0,
      scripts,
    ),
  ).toEqual([]);
});

it("rejects ambiguous script deletion from repeated ordinary words", () => {
  const text = normalized(
    "We use Θ frozen parameters and frozen evidence in every evaluation.",
  );
  const block = normalized(
    "We use Θ parameters and frozen frozen evidence in every evaluation.",
  );
  const start = text.indexOf("frozen");
  expect(
    sentenceTextRanges(text, block, [block], 0, [
      { start, end: start + "frozen".length },
    ]),
  ).toEqual([]);
});

it("retains exact matches when another requested source is outside the paragraph", () => {
  const first = normalized(
    "We choose candidate Π with consistent evidence Φ across every evaluation.",
  );
  const second = normalized("The verified result remains available.");
  const text =
    normalized(
      "We choose candidate ΠΦ with consistent evidence across every evaluation.",
    ) + second;
  const start = text.indexOf("φ");
  expect(
    sentenceTextRanges(
      text,
      first + second,
      ["unavailablesentence.", second],
      0,
      [{ start, end: start + 1 }],
    ),
  ).toEqual([{ start: text.length - second.length, end: text.length }]);
});
