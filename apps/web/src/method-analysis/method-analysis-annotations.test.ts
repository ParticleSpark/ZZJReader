// @vitest-environment jsdom
import { webcrypto, createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Annotation, MethodAnalysisLocation } from "@reader/core";
import { SavedMethodAnalysisReader } from "./MethodAnalysisReader";
import {
  indexMethodText,
  methodAnalysisContentHash,
  methodLocationRanges,
  methodSelectionOffsets,
} from "./method-analysis-text";

let host: HTMLDivElement;
let readers: SavedMethodAnalysisReader[];
let registry: Map<string, Set<Range>>;
const markdown = "# 方法\n\n第一段 **😀核心**。\n\n第二段说明。";
const events = () => ({ selection: vi.fn(), annotation: vi.fn() });
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  registry = new Map();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  host = document.createElement("div");
  host.innerHTML =
    "<h2>方法</h2><p>第一段 <strong>😀核心</strong>。</p><p>第二段说明。</p>";
  document.body.append(host);
  readers = [];
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect(10, 20, 150, 20)],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(10, 20, 150, 20),
  });
});
afterEach(() => {
  for (const reader of readers) reader.destroy();
  window.getSelection()?.removeAllRanges();
  host.remove();
  vi.unstubAllGlobals();
  delete (Range.prototype as Partial<Range>).getClientRects;
  delete (Range.prototype as Partial<Range>).getBoundingClientRect;
});
function reader(content = markdown) {
  const handlers = events();
  const instance = new SavedMethodAnalysisReader(host, content, handlers);
  readers.push(instance);
  return { instance, handlers };
}
function select(start: Text, from: number, end: Text = start, to = end.length) {
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  return range;
}
async function location(quote = "😀核心"): Promise<MethodAnalysisLocation> {
  const text = indexMethodText(host).text;
  const start = text.indexOf(quote);
  return {
    type: "method-analysis",
    contentHash: await methodAnalysisContentHash(markdown),
    start,
    end: start + quote.length,
    quote,
  };
}
async function annotation(
  id = "note",
  kind: Annotation["kind"] = "highlight",
): Promise<Annotation> {
  return {
    id,
    documentId: "paper",
    kind,
    location: await location(),
    quote: "😀核心",
    note: "",
    color: "#6cc58c",
    createdAt: "",
  };
}

it("hashes the exact saved Markdown and indexes visible UTF-16 text without controls or KaTeX duplicates", async () => {
  expect(await methodAnalysisContentHash(markdown)).toBe(
    createHash("sha256").update(markdown).digest("hex"),
  );
  host.innerHTML = `<p>公式<span class="katex"><span class="katex-mathml">重复公式及 TeX</span><span class="katex-html" aria-hidden="true">x+1</span></span>。</p>
    <div class="markdown-code"><div class="code-toolbar"><span>python</span><button>复制代码</button></div><pre><code>print("😀")</code></pre></div>
    <p hidden>隐藏</p><span aria-hidden="true">图标</span><button>按钮</button>`;
  const text = indexMethodText(host).text;
  expect(text).toContain("公式x+1。");
  expect(text).toContain('print("😀")');
  expect(text).not.toMatch(/重复|TeX|python|复制代码|隐藏|图标|按钮/);
});

it("captures keyboard and cross-paragraph selections with exact UTF-16 offsets", async () => {
  const { instance, handlers } = reader();
  await instance.ready;
  const start = host.querySelector("strong")!.firstChild as Text;
  const end = host.querySelectorAll("p")[1].firstChild as Text;
  const range = select(start, 0, end, 3);
  const selected = instance.getSelection()!;
  expect(selected.text).toBe("😀核心。\n第二段");
  expect(selected.location).toMatchObject({
    type: "method-analysis",
    quote: selected.text,
  });
  expect(selected.anchor).toEqual({ x: 160, top: 20, bottom: 40 });
  expect(handlers.selection).toHaveBeenLastCalledWith(selected);
  const index = indexMethodText(host);
  const offsets = methodSelectionOffsets(index, range)!;
  expect(index.text.slice(offsets.start, offsets.end)).toBe(selected.text);
  expect(instance.getContext()).toBe(markdown);
});

it("keeps a captured selection while its toolbar takes focus and clears it explicitly", async () => {
  const { instance, handlers } = reader();
  await instance.ready;
  select(host.querySelector("strong")!.firstChild as Text, 0);
  const selected = instance.getSelection();
  const toolbar = document.createElement("div");
  toolbar.className = "selection-bar";
  toolbar.innerHTML = "<button>绿色</button>";
  document.body.append(toolbar);
  try {
    toolbar.firstElementChild!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(instance.getSelection()).toEqual(selected);
    instance.clearSelection();
    expect(instance.getSelection()).toBeNull();
    expect(handlers.selection).toHaveBeenLastCalledWith(null);
  } finally {
    toolbar.remove();
  }
});

it("publishes a dragged selection only on release and clears the previous annotation target", async () => {
  const { instance, handlers } = reader();
  await instance.ready;
  const word = host.querySelector("strong")!;
  word.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, clientX: 15, clientY: 25 }),
  );
  select(word.firstChild as Text, 0);
  expect(instance.getSelection()).toBeNull();
  word.dispatchEvent(
    new MouseEvent("pointerup", { bubbles: true, clientX: 80, clientY: 25 }),
  );
  expect(instance.getSelection()?.text).toBe("😀核心");
  expect(instance.getSelection()?.anchor?.x).toBe(80);
  expect(handlers.annotation).toHaveBeenLastCalledWith(null);
});

it("preserves the captured text when keyboard focus moves into the toolbar", async () => {
  const { instance } = reader();
  await instance.ready;
  select(host.querySelector("strong")!.firstChild as Text, 0);
  const selected = instance.getSelection();
  const toolbar = document.createElement("div");
  toolbar.className = "selection-bar";
  toolbar.innerHTML = "<button>添加批注</button>";
  document.body.append(toolbar);
  try {
    toolbar.querySelector("button")!.focus();
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(instance.getSelection()).toEqual(selected);
  } finally {
    toolbar.remove();
  }
});

it("limits keyboard select-all to saved content and clears stale toolbar coordinates on scroll", async () => {
  const { instance, handlers } = reader();
  await instance.ready;
  host.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "a",
      ctrlKey: true,
    }),
  );
  expect(instance.getSelection()?.text).toBe(indexMethodText(host).text);
  host.dispatchEvent(new Event("scroll"));
  expect(instance.getSelection()).toBeNull();
  expect(handlers.selection).toHaveBeenLastCalledWith(null);
  expect(handlers.annotation).toHaveBeenLastCalledWith(null);
});

it("ignores selections outside the saved article, including a draft or toolbar", async () => {
  const { instance, handlers } = reader();
  await instance.ready;
  const draft = document.createElement("p");
  draft.textContent = "未完成草稿";
  document.body.append(draft);
  try {
    select(draft.firstChild as Text, 0);
    expect(instance.getSelection()).toBeNull();
    expect(handlers.selection).not.toHaveBeenCalled();
    select(
      host.querySelector("strong")!.firstChild as Text,
      0,
      draft.firstChild as Text,
      3,
    );
    expect(instance.getSelection()).toBeNull();
  } finally {
    draft.remove();
  }
});

it("repaints saved colors and underlines, activates overlapping annotations and removes deleted marks", async () => {
  const { instance, handlers } = reader();
  await instance.ready;
  const green = await annotation();
  const underline = {
    ...(await annotation("line", "underline")),
    color: "#e8746b",
  };
  instance.update([green, underline], handlers);
  expect(registry.size).toBe(2);
  expect(
    [...registry.values()].flatMap((marks) =>
      [...marks].map((r) => r.toString()),
    ),
  ).toEqual(["😀核心", "😀核心"]);
  expect(document.head.textContent).toContain(
    "text-decoration: underline 2px #e8746b",
  );
  host
    .querySelector("strong")!
    .dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 25 }),
    );
  expect(handlers.annotation).toHaveBeenLastCalledWith({
    ids: ["note", "line"],
    anchor: { x: 20, top: 17, bottom: 33 },
  });
  instance.update([{ ...green, color: "#5b9fe8" }], handlers);
  expect(registry.size).toBe(1);
  expect([...registry.keys()][0]).toContain("5b9fe8");
  instance.update([], handlers);
  expect(registry.size).toBe(0);
});

it("rejects stale versions and changed quotes instead of rebinding old annotations", async () => {
  const mark = await annotation();
  const { instance, handlers } = reader();
  await instance.ready;
  instance.update(
    [
      {
        ...mark,
        location: {
          ...(mark.location as MethodAnalysisLocation),
          contentHash: "old",
        },
      },
    ],
    handlers,
  );
  expect(registry.size).toBe(0);
  await expect(
    instance.focusLocation({
      ...(mark.location as MethodAnalysisLocation),
      contentHash: "old",
    }),
  ).rejects.toThrow("之前的解析版本");
  const changed = {
    ...(mark.location as MethodAnalysisLocation),
    quote: "不相同",
  };
  expect(
    methodLocationRanges(
      indexMethodText(host),
      (mark.location as MethodAnalysisLocation).contentHash,
      changed,
    ),
  ).toEqual([]);
  await expect(instance.focusLocation(changed)).rejects.toThrow("无法准确定位");
});

it("focuses saved locations after hash readiness and cleans up highlights and listeners", async () => {
  const target = await location();
  const { instance, handlers } = reader();
  await instance.focusLocation(target);
  expect([...registry.keys()].some((name) => name.endsWith("-focus"))).toBe(
    true,
  );
  expect(instance.getLocation()).toEqual(target);
  instance.destroy();
  expect(registry.size).toBe(0);
  const count = handlers.selection.mock.calls.length;
  select(host.querySelector("strong")!.firstChild as Text, 0);
  expect(handlers.selection).toHaveBeenCalledTimes(count);
  await expect(instance.focusLocation(target)).rejects.toThrow("已关闭");
});

it("revalidates restored annotations when Markdown replaces its rendered nodes", async () => {
  const { instance, handlers } = reader();
  await instance.ready;
  instance.update([await annotation()], handlers);
  const oldRange = [...registry.values()][0].values().next().value!;
  host
    .querySelector("strong")!
    .replaceChildren(document.createTextNode("😀核心"));
  await Promise.resolve();
  const newRange = [...registry.values()][0].values().next().value!;
  expect(newRange.startContainer.isConnected).toBe(true);
  expect(newRange.startContainer).not.toBe(oldRange.startContainer);
  host.querySelector("strong")!.textContent = "错误内容";
  await Promise.resolve();
  expect(registry.size).toBe(0);
});
