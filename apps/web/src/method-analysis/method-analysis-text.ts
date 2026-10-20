import type { MethodAnalysisLocation } from "@reader/core";

export interface MethodTextIndex {
  text: string;
  nodes: Array<{ node: Text; start: number; end: number }>;
}

const excluded =
  "button,input,textarea,select,script,style,[hidden],[inert]," +
  ".code-toolbar,.katex-mathml,.katex .vlist-s,.sr-only,.selection-bar,[data-method-analysis-exclude]";
const blocks = /^(P|H[1-6]|LI|PRE|BLOCKQUOTE|TR|TD|TH|DIV|SECTION)$/;

/** Stable visible text, with paragraph boundaries and no accessibility copies. */
export function indexMethodText(host: HTMLElement): MethodTextIndex {
  const index: MethodTextIndex = { text: "", nodes: [] };
  const newline = () => {
    if (index.text && !index.text.endsWith("\n")) index.text += "\n";
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.textContent) return;
      const start = index.text.length;
      index.text += node.textContent;
      index.nodes.push({ node: node as Text, start, end: index.text.length });
      return;
    }
    if (!(node instanceof Element)) return;
    if (
      node.matches(excluded) ||
      (node.getAttribute("aria-hidden") === "true" &&
        !node.closest(".katex-html")) ||
      (node instanceof HTMLElement &&
        (node.style.display === "none" || node.style.visibility === "hidden"))
    )
      return;
    if (node.tagName === "BR") {
      newline();
      return;
    }
    const block = blocks.test(node.tagName);
    if (block) newline();
    for (const child of node.childNodes) walk(child);
    if (block) newline();
  };
  for (const node of host.childNodes) walk(node);
  index.text = index.text.replace(/\n+$/, "");
  return index;
}

export async function methodAnalysisContentHash(markdown: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(markdown),
  );
  return Array.from(new Uint8Array(hash), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export function methodSelectionOffsets(index: MethodTextIndex, range: Range) {
  let start: number | undefined, end: number | undefined;
  for (const item of index.nodes) {
    if (!range.intersectsNode(item.node)) continue;
    const from = range.startContainer === item.node ? range.startOffset : 0;
    const to =
      range.endContainer === item.node
        ? range.endOffset
        : item.node.textContent!.length;
    if (to <= from) continue;
    start ??= item.start + from;
    end = item.start + to;
  }
  if (start === undefined || end === undefined) return;
  const selected = index.text.slice(start, end);
  const quote = selected.trim();
  if (!quote) return;
  start += selected.length - selected.trimStart().length;
  return { start, end: start + quote.length, quote };
}

/** A hash and exact quote must both match before saved offsets are trusted. */
export function methodLocationRanges(
  index: MethodTextIndex,
  contentHash: string,
  location: MethodAnalysisLocation,
  quote = location.quote,
): Range[] {
  if (
    location.contentHash !== contentHash ||
    !Number.isSafeInteger(location.start) ||
    !Number.isSafeInteger(location.end) ||
    location.start < 0 ||
    location.end <= location.start ||
    location.end > index.text.length ||
    !quote ||
    index.text.slice(location.start, location.end) !== quote
  )
    return [];
  return index.nodes.flatMap(({ node, start, end }) => {
    const from = Math.max(start, location.start),
      to = Math.min(end, location.end);
    if (to <= from) return [];
    const range = document.createRange();
    range.setStart(node, from - start);
    range.setEnd(node, to - start);
    return [range];
  });
}
