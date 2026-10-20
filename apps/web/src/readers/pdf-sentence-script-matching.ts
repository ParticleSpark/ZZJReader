type TextRange = { start: number; end: number };
type Path = { source: number; target: number; previous?: Path };
type State = {
  target: number;
  start: number;
  counts: number[];
  ways: number;
  path?: Path;
};

// Only runs identified as adjacent subscripts/superscripts by PDF geometry are
// movable. Never remove arbitrary Greek letters or ordinary words from prose.
export function relocatedScriptRanges(
  text: string,
  block: string,
  sources: string[],
  sourceOffset: number,
  scripts: TextRange[],
): TextRange[] | undefined {
  if (!scripts.length || scripts.length > 16 || block.length < 32) return;
  const tokens = [...new Set(scripts.map((r) => text.slice(r.start, r.end)))];
  if (tokens.some((token) => !/^[\p{L}\p{N}]{1,16}$/u.test(token))) return;
  const available = tokens.map(
    (token) =>
      scripts.filter((r) => text.slice(r.start, r.end) === token).length,
  );
  let value = "";
  const positions: number[] = [];
  let script = 0;
  for (let i = 0; i < text.length;) {
    if (script < scripts.length && i === scripts[script].start) {
      i = scripts[script++].end;
    } else {
      positions.push(i);
      value += text[i++];
    }
  }
  const removed = text.length - value.length;
  if (removed > block.length * 0.2 || block.length > 8192) return;

  // A bounded subsequence search keeps all prose exact, permitting only whole
  // script tokens to move. Two valid alignments are ambiguous and rejected.
  const levels = Array.from(
    { length: block.length + 1 },
    () => new Map<string, State>(),
  );
  let states = 0;
  const add = (index: number, state: State) => {
    const key = `${state.start}:${state.target}:${state.counts.join(",")}`;
    const existing = levels[index].get(key);
    if (existing) existing.ways = Math.min(2, existing.ways + state.ways);
    else {
      if (states >= 50_000) return false;
      levels[index].set(key, state);
      states++;
    }
    return true;
  };
  for (let start = 0; start <= value.length - block.length + removed; start++) {
    if (!add(0, { start, target: start, counts: tokens.map(() => 0), ways: 1 }))
      return;
  }
  let matched: Path | undefined;
  for (let i = 0; i <= block.length; i++) {
    for (const state of levels[i].values()) {
      const { target, start, counts, ways, path } = state;
      if (i === block.length) {
        if (target <= start) continue;
        const first = positions[start],
          last = positions[target - 1] + 1;
        const included = scripts.filter(
          (r) => r.start >= first && r.end <= last,
        );
        if (
          !included.length ||
          counts.some(
            (count, k) =>
              count !==
              included.filter((r) => text.slice(r.start, r.end) === tokens[k])
                .length,
          )
        )
          continue;
        if (matched || ways !== 1) return;
        matched = path;
        continue;
      }
      if (block[i] === value[target]) {
        if (
          !add(i + 1, {
            ...state,
            target: target + 1,
            path: { source: i, target, previous: path },
          })
        )
          return;
      }
      for (let k = 0; k < tokens.length; k++) {
        if (counts[k] >= available[k] || !block.startsWith(tokens[k], i))
          continue;
        const next = [...counts];
        next[k]++;
        if (!add(i + tokens[k].length, { ...state, counts: next })) return;
      }
    }
  }
  if (!matched) return;
  const offsets = new Map<number, number>();
  for (let step: Path | undefined = matched; step; step = step.previous)
    offsets.set(step.source, positions[step.target]);
  const ranges: TextRange[] = [];
  let cursor = sourceOffset;
  for (const source of sources) {
    if (!source) continue;
    const start = block.indexOf(source, cursor);
    if (start < 0) return;
    cursor = start + source.length;
    let first: number | undefined, last: number | undefined;
    for (let i = start; i < cursor; i++) {
      const offset = offsets.get(i);
      if (offset !== undefined) {
        first ??= offset;
        last = offset;
      }
    }
    if (first !== undefined && last !== undefined)
      ranges.push({ start: first, end: last + 1 });
  }
  return ranges;
}
