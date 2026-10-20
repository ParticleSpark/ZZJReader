// @vitest-environment jsdom
import { act, useEffect } from "react";
import { webcrypto } from "node:crypto";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import {
  defaultTheme,
  type Annotation,
  type Document,
  type PDFBlock,
  type PDFReadingAnchor,
  type Processing,
  type ReaderAdapter,
  type ReaderEvents,
  type ReaderTheme,
  type SearchResult,
  type TranslationBlock,
} from "@reader/core";
const fixture = vi.hoisted(() => ({
  events: undefined as ReaderEvents | undefined,
  ready: undefined as ReaderAdapter | undefined,
  openingAnchor: undefined as PDFReadingAnchor | undefined,
  translations: [] as TranslationBlock[],
  push: undefined as
    | ((
        event:
          | { event: "snapshot"; data: TranslationBlock[] }
          | { event: "translation"; data: TranslationBlock },
      ) => void)
    | undefined,
  signal: undefined as AbortSignal | undefined,
}));
vi.mock("@reader/api", () => ({
  api: {
    methodAnalysis: vi.fn(async () => ({
      documentId: "doc",
      status: "complete",
      content: "论文方法解析结果",
      detail: "",
    })),
    startMethodAnalysis: vi.fn(async () => ({
      documentId: "doc",
      status: "complete",
      content: "论文方法解析结果",
      detail: "",
    })),
    saveSettings: vi.fn(async () => ({})),
    assistance: vi.fn(async () => undefined),
    translationStream: vi.fn(
      async (
        _id: string,
        signal: AbortSignal,
        onEvent: NonNullable<typeof fixture.push>,
      ) => {
        fixture.push = onEvent;
        fixture.signal = signal;
        onEvent({ event: "snapshot", data: fixture.translations });
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    ),
    translate: vi.fn(async () => ({ queued: true })),
  },
  blockImageURL: () => "",
}));
vi.mock("../chat/MessageMarkdown", () => ({
  MessageMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock("../DocumentNotePage", () => ({
  DocumentNotePage: () => <div>笔记编辑器</div>,
}));
const adapter = {
  open: vi.fn(async () => {}),
  getTOC: vi.fn(async () => []),
  getLocation: () => ({ type: "pdf", page: 1 }),
  goTo: vi.fn(async () => {}),
  next: vi.fn(async () => {}),
  previous: vi.fn(async () => {}),
  search: vi.fn(async () => []),
  getSelection: () => null,
  clearSelection: vi.fn(),
  highlight: vi.fn(async () => {}),
  setTheme: vi.fn(async () => {}),
  getContext: vi.fn(async () => ""),
  destroy: vi.fn(async () => {}),
  focusBlock: vi.fn(async () => {}),
  adjustZoom: vi.fn(),
  cancelBlockFocus: vi.fn(),
  followBlock: vi.fn(async () => {}),
  focusSentences: vi.fn(async () => {}),
  hoverBlock: vi.fn(),
} as unknown as ReaderAdapter;
vi.mock("../ReaderView", () => ({
  ReaderView: ({
    events,
    onReady,
  }: {
    events: ReaderEvents;
    onReady: (a: ReaderAdapter, t: []) => void;
  }) => {
    fixture.events = events;
    useEffect(() => {
      if (fixture.openingAnchor) events.readingAnchor?.(fixture.openingAnchor);
      onReady(adapter, []);
    }, []);
    return <div>PDF 原文</div>;
  },
}));
import { PDFReadingView } from "./PDFReadingView";
import { methodAnalysisContentHash } from "../method-analysis/method-analysis-text";
let root: Root, host: HTMLDivElement;
const events = {
  location: vi.fn(),
  selection: vi.fn(),
  annotation: vi.fn(),
};
beforeEach(async () => {
  fixture.openingAnchor = undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  fixture.translations = [
    {
      blockId: "p1-b1",
      sourceHash: "hash",
      status: "complete",
      sentences: [
        { source: "First sentence.", target: "第一句。" },
        { source: "Second sentence.", target: "第二句。" },
      ],
    },
  ];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await renderView();
});
async function renderView(
  theme: ReaderTheme = defaultTheme,
  extraBlocks: PDFBlock[] = [],
  searchResults: SearchResult[] = [],
  status?: {
    processing?: Processing;
    library?: "papers" | "books";
    parsed?: boolean;
    annotations?: Annotation[];
  },
) {
  await act(async () =>
    root.render(
      <PDFReadingView
        document={
          { id: "doc", type: "pdf", library: status?.library } as Document
        }
        theme={theme}
        annotations={status?.annotations ?? []}
        searchResults={searchResults}
        processing={status?.processing}
        blocks={
          status && !status.parsed
            ? []
            : [
                {
                  id: "p1-b1",
                  page: 1,
                  label: "text",
                  text: "First sentence. Second sentence.",
                  bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
                },
                ...extraBlocks,
              ]
        }
        events={events}
        onReady={(a) => {
          fixture.ready = a;
        }}
      />,
    ),
  );
}

const processing: Processing = {
  documentId: "doc",
  phase: "learning",
  status: "running",
  enabled: true,
  pagesDone: 1,
  pagesTotal: 2,
  translationsDone: 0,
  translationsTotal: 0,
  detail: "正在解析 PDF",
  updatedAt: "2026-10-12T00:00:00Z",
};

it("opens saved paper analysis without starting AI and retains the PDF reader behind it", async () => {
  await renderView(defaultTheme, [], [], { library: "papers", parsed: true });
  const reader = host.querySelector(".translation-source");
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "仅原文",
    "原文译文",
    "仅译文",
    "方法解析",
    "笔记",
  ]);
  expect(api.methodAnalysis).not.toHaveBeenCalled();
  await act(async () =>
    tabs.find((tab) => tab.textContent === "方法解析")!.click(),
  );
  expect(host.textContent).toContain("论文方法解析结果");
  expect(api.startMethodAnalysis).not.toHaveBeenCalled();
  expect(host.querySelector(".translation-stage")?.hasAttribute("inert")).toBe(
    true,
  );
  await click("仅原文");
  expect(host.querySelector(".translation-source")).toBe(reader);
  expect(host.querySelector(".translation-stage")?.hasAttribute("inert")).toBe(
    false,
  );
  expect(adapter.destroy).not.toHaveBeenCalled();
});

it("starts paper analysis from the toolbar while leaving books unchanged", async () => {
  await renderView(defaultTheme, [], [], { library: "books", parsed: true });
  expect(host.textContent).not.toContain("方法解析");
  await renderView(defaultTheme, [], [], { library: "papers", parsed: true });
  const button = [
    ...host.querySelectorAll<HTMLButtonElement>('button:not([role="tab"])'),
  ].find((button) => button.textContent === "方法解析")!;
  await act(async () => button.click());
  expect(api.startMethodAnalysis).toHaveBeenCalledExactlyOnceWith("doc", false);
  expect(host.querySelector('[aria-label="论文方法解析"]')).toBeTruthy();
});

it("opens a saved method reference, shares selections and returns to the PDF without changing paper progress", async () => {
  vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect(20, 30, 120, 20)],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(20, 30, 120, 20),
  });
  try {
    await renderView(defaultTheme, [], [], { library: "papers", parsed: true });
    const location = {
      type: "method-analysis" as const,
      contentHash: await methodAnalysisContentHash("论文方法解析结果"),
      start: 2,
      end: 6,
      quote: "方法解析",
    };
    let focus!: Promise<void>;
    await act(async () => {
      focus = fixture.ready!.focusLocation!(location);
    });
    await act(async () => await focus);
    expect(api.startMethodAnalysis).not.toHaveBeenCalled();
    expect(adapter.goTo).not.toHaveBeenCalled();
    expect(await fixture.ready!.getContext()).toBe("论文方法解析结果");
    expect(fixture.ready!.getLocation()).toEqual(location);
    expect(
      events.location.mock.calls.some(
        ([value]) => value.type === "method-analysis",
      ),
    ).toBe(false);

    const text = host.querySelector(".method-analysis-body p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 6);
    await act(async () => {
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const selected = fixture.ready!.getSelection()!;
    expect(selected.text).toBe("方法解析");
    expect(selected.location).toEqual(location);
    expect(await fixture.ready!.prepareAnnotation!(selected)).toEqual(selected);
    expect(events.selection).toHaveBeenLastCalledWith(selected);
    // The still-mounted PDF engine also observes global selection changes.
    await act(async () => fixture.events!.selection(null));
    expect(events.selection).toHaveBeenLastCalledWith(selected);
    await act(async () => fixture.ready!.clearSelection());
    expect(events.selection).toHaveBeenLastCalledWith(null);
    await act(async () => fixture.ready!.goTo({ type: "pdf", page: 2 }));
    expect(host.querySelector(".method-analysis-page")).toBeNull();
    expect(adapter.goTo).toHaveBeenLastCalledWith({ type: "pdf", page: 2 });
  } finally {
    window.getSelection()?.removeAllRanges();
    delete (Range.prototype as Partial<Range>).getClientRects;
    delete (Range.prototype as Partial<Range>).getBoundingClientRect;
  }
});

it("activates method marks without hidden translation marks intercepting the same pointer coordinates", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const highlights = new Map<string, Set<Range>>();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  // Hidden ranges retain their layout geometry in the browser. Give both
  // articles the same coordinates so the former root-level listener collides.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect(20, 30, 120, 20)],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(20, 30, 120, 20),
  });
  try {
    const translated: Annotation = {
      id: "translation-mark",
      documentId: "doc",
      kind: "highlight",
      color: "#e6b94c",
      note: "",
      quote: "第一句。",
      createdAt: "",
      location: {
        type: "pdf",
        page: 1,
        translation: {
          blockId: "p1-b1",
          sourceHash: "hash",
          sentenceIndexes: [0],
          start: 4,
          end: 8,
        },
      },
    };
    const method: Annotation = {
      ...translated,
      id: "method-mark",
      quote: "方法解析",
      location: {
        type: "method-analysis",
        contentHash: await methodAnalysisContentHash("论文方法解析结果"),
        start: 2,
        end: 6,
        quote: "方法解析",
      },
    };
    await renderView(defaultTheme, [], [], {
      library: "papers",
      parsed: true,
      annotations: [translated, method],
    });
    await click("原文译文");
    const clickText = async (element: Element) => {
      await act(async () => {
        for (const type of ["pointerdown", "pointerup", "click"])
          element.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: 30,
              clientY: 40,
            }),
          );
      });
    };
    const translatedText = host.querySelector('[data-sentence="0"]')!;
    const translatedRange = [...highlights.values()]
      .flatMap((ranges) => [...ranges])
      .find((range) => range.toString() === "第一句。");
    expect(translatedRange).toBeDefined();
    await clickText(translatedText);
    expect(events.annotation).toHaveBeenLastCalledWith(
      expect.objectContaining({ ids: ["translation-mark"] }),
    );

    const tab = [...host.querySelectorAll('[role="tab"]')].find(
      (item) => item.textContent === "方法解析",
    ) as HTMLButtonElement;
    await act(async () => tab.click());
    await vi.waitFor(() =>
      expect(fixture.ready!.getLocation().type).toBe("method-analysis"),
    );
    expect(
      host.querySelector(".translation-stage")?.getAttribute("inert"),
    ).toBe("");
    expect(translatedRange!.startContainer.isConnected).toBe(true);
    expect(translatedRange!.getBoundingClientRect()).toEqual(
      new DOMRect(20, 30, 120, 20),
    );
    expect(
      [...highlights.values()].flatMap((ranges) =>
        [...ranges].map((range) => range.toString()),
      ),
    ).toContain("方法解析");
    events.annotation.mockClear();
    await clickText(host.querySelector(".method-analysis-body p")!);
    expect(events.annotation).toHaveBeenLastCalledWith(
      expect.objectContaining({ ids: ["method-mark"] }),
    );
    expect(
      events.annotation.mock.calls.some(([target]) =>
        target?.ids.includes("translation-mark"),
      ),
    ).toBe(false);
  } finally {
    window.getSelection()?.removeAllRanges();
    delete (Range.prototype as Partial<Range>).getClientRects;
    delete (Range.prototype as Partial<Range>).getBoundingClientRect;
  }
});

it("replaces the parsing notice with the actual failure and retry guidance", async () => {
  await renderView(defaultTheme, [], [], { processing });
  await click("原文译文");
  expect(host.textContent).toContain("正在解析正文，解析完成后将开始翻译");
  await renderView(defaultTheme, [], [], {
    processing: {
      ...processing,
      status: "failed",
      pagesDone: 2,
      detail: "PDF 解析未完成，请检查文件或重建",
    },
  });
  const warning = host.querySelector('[role="alert"]');
  expect(warning?.textContent).toContain("正文解析失败");
  expect(warning?.textContent).toContain("PDF 解析未完成，请检查文件或重建");
  expect(warning?.textContent).toContain("可在工具栏重试翻译");
  expect(host.textContent).not.toContain("正在解析正文");
  expect(host.textContent).toContain("重试翻译");
});

it.each([
  { status: "paused" as const, startedAt: undefined, message: "翻译尚未开始" },
  {
    status: "paused" as const,
    startedAt: "2026-10-12T00:00:00Z",
    message: "翻译已暂停",
  },
  {
    status: "waiting" as const,
    startedAt: undefined,
    message: "请先配置可用的 AI 连接",
  },
  {
    status: "complete" as const,
    startedAt: undefined,
    message: "未找到可翻译的正文",
  },
])(
  "does not claim parsing is active when $status",
  async ({ status, startedAt, message }) => {
    await renderView(defaultTheme, [], [], {
      processing: {
        ...processing,
        status,
        startedAt,
        enabled: status !== "paused",
        detail: status === "waiting" ? message : "",
      },
    });
    await click("原文译文");
    expect(host.textContent).toContain(message);
    expect(host.textContent).not.toContain("正在解析正文");
    expect(host.textContent).not.toContain("正文仍在解析中");
  },
);

it("keeps chapter guidance for idle PDF books but shows chapter parsing failures", async () => {
  await renderView(defaultTheme, [], [], {
    library: "books",
    processing: { ...processing, phase: "ready", status: "complete" },
  });
  await click("原文译文");
  expect(host.textContent).toContain("尚未翻译任何章节，可在工具栏翻译本章");
  await renderView(defaultTheme, [], [], {
    library: "books",
    processing: { ...processing, status: "failed", detail: "无法保存解析附件" },
  });
  expect(host.textContent).toContain("正文解析失败");
  expect(host.textContent).toContain("无法保存解析附件");
  expect(host.textContent).not.toContain("尚未翻译任何章节");
});

it("uses repaired text for search and focuses the matching block", async () => {
  const results = await fixture.ready!.search("第二句");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ blockId: "p1-b1", side: "translation" });
  await renderView(defaultTheme, [], results);
  await click("原文译文");
  expect(
    host
      .querySelector('[data-translation-block="p1-b1"]')
      ?.hasAttribute("data-search-hit"),
  ).toBe(true);
  await act(async () => fixture.ready!.focusLocation!(results[0].location));
  expect(adapter.focusBlock).toHaveBeenCalledWith("p1-b1", "parallel");
});

it("retains PDF.js search on pages without parsed blocks", async () => {
  adapter.getPageCount = () => 2;
  vi.mocked(adapter.search).mockResolvedValueOnce([
    { id: "2", excerpt: "raw page", location: { type: "pdf", page: 2 } },
  ]);
  const results = await fixture.ready!.search("raw");
  expect(results).toMatchObject([
    { id: "2", location: { type: "pdf", page: 2 } },
  ]);
  delete adapter.getPageCount;
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = Array.from(
    host.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
  if (label === "原文译文" && !vi.isFakeTimers()) {
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
  }
}
it("makes the covered PDF inert while retaining its reading pane and position across notes", async () => {
  await click("原文译文");
  const stage = host.querySelector<HTMLElement>(".translation-stage")!;
  const source = host.querySelector<HTMLElement>(".translation-source")!;
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  pane.scrollTop = 417;
  vi.mocked(adapter.followBlock!).mockClear();
  vi.mocked(adapter.goTo).mockClear();
  vi.mocked(adapter.adjustZoom!).mockClear();
  await click("笔记");
  expect(stage.hasAttribute("inert")).toBe(true);
  expect(source.closest("[inert]")).toBe(stage);
  expect(fixture.signal?.aborted).toBe(false);
  await click("原文译文");
  expect(stage.hasAttribute("inert")).toBe(false);
  expect(host.querySelector(".translation-source")).toBe(source);
  expect(host.querySelector(".translation-document")).toBe(pane);
  expect(pane.scrollTop).toBe(417);
  expect(adapter.destroy).not.toHaveBeenCalled();
  expect(adapter.goTo).not.toHaveBeenCalled();
  expect(adapter.followBlock).not.toHaveBeenCalled();
  expect(adapter.adjustZoom).not.toHaveBeenCalled();
});

it("opens a paper in parallel without recentering the restored reading position", async () => {
  fixture.openingAnchor = { blockId: "p1-b1", fraction: 0.6 };
  await act(async () =>
    root.render(
      <PDFReadingView
        key="fresh-paper"
        document={
          {
            id: "fresh-paper",
            type: "pdf",
            library: "papers",
            progress: { type: "pdf", page: 1, x: 0.1, y: 0.38 },
          } as Document
        }
        theme={defaultTheme}
        annotations={[]}
        blocks={[
          {
            id: "p1-b1",
            page: 1,
            label: "text",
            text: "First sentence. Second sentence.",
            bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
        ]}
        events={events}
        onReady={(reader) => {
          fixture.ready = reader;
        }}
      />,
    ),
  );
  expect(
    host.querySelector(".translation-panes")?.getAttribute("data-mode"),
  ).toBe("parallel");
  // A genuine mode switch queues centering across two layout frames.
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  expect(adapter.adjustZoom).not.toHaveBeenCalled();
  expect(adapter.followBlock).not.toHaveBeenCalled();
  expect(adapter.focusBlock).not.toHaveBeenCalled();
  expect(adapter.goTo).not.toHaveBeenCalled();
  const { pane } = translationGeometry();
  await click("仅译文");
  expect(fixture.ready!.getLocation()).toMatchObject({
    type: "pdf",
    page: 1,
    x: 0.1,
    y: expect.closeTo(0.38),
  });
  expect(pane.scrollTop).toBe(420);
});

it("switches modes without recreating the PDF and links an original selection to its sentence", async () => {
  await click("原文译文");
  expect(adapter.focusBlock).not.toHaveBeenCalled();
  await act(async () =>
    fixture.events!.selection({
      text: "Second",
      location: {
        type: "pdf",
        page: 1,
        rects: [{ x: 0.1, y: 0.25, width: 0.2, height: 0.02 }],
      },
    }),
  );
  const marked = host.querySelector('[data-sentence="1"]');
  expect(marked?.hasAttribute("data-linked")).toBe(true);
  expect(
    host.querySelector('[data-sentence="0"]')?.hasAttribute("data-linked"),
  ).toBe(false);
  await click("仅译文");
  expect(host.querySelector(".translation-source")?.hasAttribute("inert")).toBe(
    true,
  );
  await click("仅原文");
  expect(host.querySelector(".translation-document")).toBeNull();
  expect(adapter.destroy).not.toHaveBeenCalled();
});
it("keeps the translated selection as the quote and anchors its counterpart to original text", async () => {
  const highlights = new Map<string, Set<Range>>();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  await click("原文译文");
  const sentence = host.querySelector('[data-sentence="1"] p')!;
  await act(async () =>
    sentence.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
  );
  const range = document.createRange();
  range.selectNodeContents(sentence);
  Object.assign(range, {
    getBoundingClientRect: () => new DOMRect(200, 100, 80, 20),
  });
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  expect(
    [...highlights.get("reader-translation-selection")!][0].toString(),
  ).toBe("第二句。");
  expect(
    host
      .querySelector(".translation-document")
      ?.hasAttribute("data-compact-selection"),
  ).toBe(true);
  await act(async () =>
    sentence.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })),
  );
  expect(events.selection).toHaveBeenLastCalledWith(
    expect.objectContaining({
      text: "第二句。",
      location: expect.objectContaining({
        quote: "Second sentence.",
        translation: expect.objectContaining({
          blockId: "p1-b1",
          sentenceIndexes: [1],
        }),
      }),
    }),
  );
  expect(adapter.focusSentences).toHaveBeenLastCalledWith(
    "p1-b1",
    ["Second sentence."],
    true,
  );
  await act(async () => fixture.ready!.clearSelection());
  expect(events.selection).toHaveBeenLastCalledWith(null);
  document.dispatchEvent(new Event("selectionchange"));
  expect(highlights.has("reader-translation-selection")).toBe(false);
});
it("focuses the visible middle translation once when entering parallel mode", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  await click("仅译文");
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  const block = pane.querySelector<HTMLElement>("[data-translation-block]")!;
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  block.getBoundingClientRect = () => new DOMRect(0, 80, 600, 400);
  await act(async () => {
    pane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    pane.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  expect(adapter.followBlock).not.toHaveBeenCalled();
  await click("原文译文");
  expect(adapter.adjustZoom).toHaveBeenCalledWith("width");
  expect(adapter.focusBlock).not.toHaveBeenCalled();
  expect(adapter.followBlock).toHaveBeenCalledExactlyOnceWith({
    blockId: "p1-b1",
    fraction: 0.5,
  });
  await renderView({ ...defaultTheme, translationFontSize: 1.2 });
  expect(adapter.focusBlock).not.toHaveBeenCalled();
  await click("仅译文");
  await click("原文译文");
  expect(adapter.followBlock).toHaveBeenCalledTimes(2);
  expect(adapter.focusBlock).not.toHaveBeenCalled();
});

it("chooses the source viewport's middle block before resizing, even with a stale reading anchor", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  await renderView(defaultTheme, [
    {
      id: "p1-b2",
      page: 1,
      label: "text",
      text: "Middle block.",
      bounds: { x: 0.1, y: 0.55, width: 0.3, height: 0.1 },
    },
  ]);
  await act(async () =>
    fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0 }),
  );
  const source = document.createElement("div");
  source.className = "pdf-container";
  source.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  page.getBoundingClientRect = () => new DOMRect(0, -300, 1000, 1000);
  source.append(page);
  host.querySelector(".translation-source")!.append(source);
  await click("原文译文");
  expect(adapter.focusBlock).not.toHaveBeenCalled();
  expect(adapter.followBlock).toHaveBeenCalledExactlyOnceWith({
    blockId: "p1-b2",
    fraction: 0.5,
  });
  await click("交换原文和译文");
  expect(adapter.followBlock).toHaveBeenCalledTimes(1);
  await click("仅原文");
  await click("原文译文");
  expect(adapter.followBlock).toHaveBeenLastCalledWith({
    blockId: "p1-b2",
    fraction: 0.5,
  });
});

it("navigates to the matching bibliography block and restores the translated viewport fraction", async () => {
  await renderView(defaultTheme, [
    {
      id: "p9-first",
      page: 9,
      label: "text",
      text: "Before references",
      bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
    },
    {
      id: "p9-ref",
      page: 9,
      label: "reference_content",
      text: "[6] Reference",
      bounds: { x: 0.1, y: 0.6, width: 0.3, height: 0.2 },
    },
  ]);
  await click("仅译文");
  const { pane } = translationGeometry();
  const reference = host.querySelector<HTMLElement>(
    '[data-translation-block="p9-ref"]',
  )!;
  reference.getBoundingClientRect = () =>
    new DOMRect(40, 1200 - pane.scrollTop, 520, 200);
  pane.scrollTop = 400;
  await act(async () => {
    pane.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    pane.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
  const origin = fixture.ready!.getLocation();
  expect(origin).toEqual({ type: "pdf", page: 1, x: 0.1, y: 0.35 });
  await act(async () =>
    fixture.ready!.goTo({ type: "pdf", page: 9, x: 0.1, y: 0.7 }),
  );
  expect(pane.scrollTop).toBeCloseTo(1000);
  expect(fixture.ready!.isNear?.(origin)).toBe(false);
  await act(async () => fixture.ready!.goTo(origin));
  expect(pane.scrollTop).toBeCloseTo(400);
  expect(fixture.ready!.isNear?.(origin)).toBe(true);
});

it("renders an incoming paragraph while the subscription remains open", async () => {
  await click("原文译文");
  const block = fixture.translations[0];
  await act(async () =>
    fixture.push!({
      event: "snapshot",
      data: [{ ...block, status: "pending", sentences: [] }],
    }),
  );
  expect(host.textContent).toContain("等待翻译");
  expect(host.textContent).not.toContain("优先翻译");
  await act(async () => fixture.push!({ event: "translation", data: block }));
  expect(host.textContent).toContain("第一句。");
  expect(fixture.signal!.aborted).toBe(false);
});

it("shows blocked translation reasons after parsing and updates pending paragraphs without losing completed text", async () => {
  await click("原文译文");
  const extra: PDFBlock = {
    id: "p1-b2",
    page: 1,
    label: "text",
    text: "Untranslated paragraph.",
    bounds: { x: 0.1, y: 0.6, width: 0.3, height: 0.2 },
  };
  await act(async () =>
    fixture.push!({
      event: "translation",
      data: {
        blockId: extra.id,
        sourceHash: "pending",
        status: "pending",
        sentences: [],
      },
    }),
  );
  for (const [status, label] of [
    ["waiting", "等待 AI 配置"],
    ["failed", "翻译已停止"],
  ] as const) {
    await renderView(defaultTheme, [extra], [], {
      parsed: true,
      processing: {
        ...processing,
        phase: "translating",
        status: "running",
        pagesDone: 21,
        pagesTotal: 21,
        translating: { status, detail: "主 Agent 尚未通过所需能力测试" },
      },
    });
    const pane = host.querySelector(".translation-document")!;
    expect(pane.textContent).toContain("第一句。");
    expect(
      pane.querySelector('[data-translation-block="p1-b2"]')?.textContent,
    ).toContain(label);
    expect(pane.textContent).not.toContain("正在翻译中");
    const notice = pane.querySelector(".translation-warning")!;
    expect(notice.textContent).toContain("主 Agent 尚未通过所需能力测试");
    expect(notice.textContent).toContain(
      status === "waiting" ? "设置中的 AI 连接和能力测试" : "工具栏重试翻译",
    );
    expect(pane.querySelectorAll(".translation-warning")).toHaveLength(1);
  }
  expect(fixture.signal!.aborted).toBe(false);
});

it("links block hover in both directions and clears it without changing sentence selections", async () => {
  await click("原文译文");
  vi.mocked(adapter.focusSentences!).mockClear();
  await act(async () =>
    fixture.events!.blockHover?.({
      id: "p1-b1",
    } as import("@reader/core").PDFBlock),
  );
  const block = host.querySelector<HTMLElement>(
    '[data-translation-block="p1-b1"]',
  )!;
  expect(block.hasAttribute("data-hovered")).toBe(true);
  await act(async () => fixture.events!.blockHover?.(null));
  expect(block.hasAttribute("data-hovered")).toBe(false);
  await act(async () =>
    block.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
  );
  expect(adapter.hoverBlock).toHaveBeenLastCalledWith("p1-b1");
  expect(block.hasAttribute("data-hovered")).toBe(true);
  await act(async () =>
    block.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: host }),
    ),
  );
  expect(adapter.hoverBlock).toHaveBeenLastCalledWith(null);
  expect(block.hasAttribute("data-hovered")).toBe(false);
  expect(adapter.focusSentences).not.toHaveBeenCalled();
  expect(adapter.clearSelection).not.toHaveBeenCalled();
  await act(async () =>
    block.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
  );
  await click("仅原文");
  expect(adapter.hoverBlock).toHaveBeenLastCalledWith(null);
});

it("supports explicit block focus in source and parallel modes", async () => {
  expect(adapter.focusBlock).not.toHaveBeenCalled();
  await act(async () =>
    fixture.events!.blockFocus?.({
      id: "p1-b1",
      page: 1,
      bounds: { x: 0, y: 0 },
    } as PDFBlock),
  );
  expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b1", "source");
  await click("原文译文");
  await act(async () =>
    fixture.events!.blockFocus?.({
      id: "p1-b1",
      page: 1,
      bounds: { x: 0, y: 0 },
    } as PDFBlock),
  );
  expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b1", "parallel");
});

it("focuses the paragraph containing a saved annotation like clicking it", async () => {
  await renderView(defaultTheme, [
    {
      id: "p1-b2",
      page: 1,
      label: "text",
      text: "Lower paragraph.",
      bounds: { x: 0.1, y: 0.55, width: 0.3, height: 0.2 },
    },
  ]);
  // Source selections store only rects; the page origin must not win.
  await act(async () =>
    fixture.ready!.focusLocation?.({
      type: "pdf",
      page: 1,
      quote: "Lower",
      rects: [{ x: 0.12, y: 0.6, width: 0.1, height: 0.02 }],
    }),
  );
  expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b2", "source");
  await click("原文译文");
  await act(async () =>
    fixture.ready!.focusLocation?.({
      type: "pdf",
      page: 1,
      translation: {
        blockId: "p1-b1",
        sourceHash: "hash",
        sentenceIndexes: [1],
        start: 0,
        end: 3,
      },
    }),
  );
  expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b1", "parallel");
  expect(adapter.goTo).not.toHaveBeenCalled();
});

it("always follows scrolling in either pane without an unlink control", async () => {
  await click("原文译文");
  expect(host.querySelector('[aria-label="同步滚动"]')).toBeNull();
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  const block = pane.querySelector<HTMLElement>("[data-translation-block]")!;
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  block.getBoundingClientRect = () => new DOMRect(0, 80, 600, 400);
  await act(async () =>
    fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.5 }),
  );
  expect(pane.scrollTop).toBe(-20);
  expect(host.querySelector("[data-focused]")).toBeNull();
  await act(async () => {
    pane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    pane.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
  expect(adapter.followBlock).toHaveBeenLastCalledWith({
    blockId: "p1-b1",
    fraction: 0.55,
  });
});

function translationGeometry(height = 200) {
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  const block = pane.querySelector<HTMLElement>("[data-translation-block]")!;
  Object.defineProperties(pane, {
    clientWidth: { value: 600, configurable: true },
    clientHeight: { value: 600, configurable: true },
    scrollHeight: { value: 2400, configurable: true },
  });
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  block.getBoundingClientRect = () =>
    new DOMRect(40, 600 - pane.scrollTop, 520, height);
  return { pane, block };
}
it.each([
  { text: "Second", sentenceTop: 640 },
  { text: "Second sentence", sentenceTop: 1400 },
])(
  "keeps the translated viewport and reading anchor when selecting $text after hover",
  async ({ text, sentenceTop }) => {
    await click("原文译文");
    const { pane, block } = translationGeometry();
    const source = host.querySelector<HTMLElement>(".translation-source")!;
    const sentence = block.querySelector<HTMLElement>('[data-sentence="1"]')!;
    sentence.getBoundingClientRect = () =>
      new DOMRect(40, sentenceTop - pane.scrollTop, 180, 24);
    await act(async () =>
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.6 }),
    );
    expect(pane.scrollTop).toBe(420);
    await act(async () =>
      fixture.events!.blockHover?.({ id: "p1-b1" } as PDFBlock),
    );
    expect(block.hasAttribute("data-hovered")).toBe(true);
    expect(pane.scrollTop).toBe(420);
    await act(async () => {
      source.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      fixture.events!.selection({
        text,
        location: {
          type: "pdf",
          page: 1,
          rects: [{ x: 0.1, y: 0.25, width: 0.2, height: 0.02 }],
        },
      });
    });
    expect(sentence.hasAttribute("data-linked")).toBe(true);
    expect(events.selection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text,
        location: expect.objectContaining({
          sentenceLink: expect.objectContaining({
            origin: "source",
            parts: [
              expect.objectContaining({ blockId: "p1-b1", sentenceIndex: 1 }),
            ],
          }),
        }),
      }),
    );
    expect(pane.scrollTop).toBe(420);
    await act(async () => {
      source.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      fixture.events!.selection(null);
      fixture.events!.blockHover?.(null);
    });
    expect(sentence.hasAttribute("data-linked")).toBe(false);
    expect(pane.scrollTop).toBe(420);
    // Translation mode exposes the saved reading anchor through the adapter.
    await click("仅译文");
    expect(fixture.ready!.getLocation()).toMatchObject({
      type: "pdf",
      page: 1,
      x: 0.1,
      y: expect.closeTo(0.38),
    });
    expect(pane.scrollTop).toBe(420);
  },
);

it("holds the translation still during source drags and resumes scrolling after release or cancellation", async () => {
  await click("原文译文");
  const { pane } = translationGeometry();
  const source = host.querySelector<HTMLElement>(".translation-source")!;
  await act(async () =>
    fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.25 }),
  );
  expect(pane.scrollTop).toBe(350);
  for (const [release, fraction] of [
    ["pointerup", 0.75],
    ["pointercancel", 0.5],
  ] as const) {
    const before = pane.scrollTop;
    await act(async () => {
      source.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.9 });
    });
    expect(pane.scrollTop).toBe(before);
    await act(async () => {
      source.dispatchEvent(new MouseEvent(release, { bubbles: true }));
      fixture.events!.selection(null);
      source.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: 100 }),
      );
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction });
    });
    expect(pane.scrollTop).toBe(300 + fraction * 200);
  }
});

it("ignores sentence matching that finishes after the source selection was cleared", async () => {
  await click("原文译文");
  const { pane } = translationGeometry();
  await act(async () =>
    fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.6 }),
  );
  type Matches = Awaited<
    ReturnType<NonNullable<ReaderAdapter["matchSentences"]>>
  >;
  let finish!: (links: Matches) => void;
  adapter.matchSentences = vi.fn(
    () =>
      new Promise<Matches>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await act(async () =>
      fixture.events!.selection({
        text: "Second",
        location: {
          type: "pdf",
          page: 1,
          rects: [{ x: 0.1, y: 0.25, width: 0.2, height: 0.02 }],
        },
      }),
    );
    expect(adapter.matchSentences).toHaveBeenCalledTimes(1);
    await act(async () => fixture.ready!.clearSelection());
    const calls = events.selection.mock.calls.length;
    await act(async () => finish([{ blockId: "p1-b1", sentenceIndexes: [1] }]));
    expect(events.selection).toHaveBeenCalledTimes(calls);
    expect(events.selection).toHaveBeenLastCalledWith(null);
    expect(fixture.ready!.getSelection()).toBeNull();
    expect(host.querySelector("[data-linked]")).toBeNull();
    expect(pane.scrollTop).toBe(420);
  } finally {
    delete adapter.matchSentences;
  }
});

it("smoothly centers clicked translation blocks and follows their original without scroll feedback", async () => {
  await click("原文译文");
  const { pane, block } = translationGeometry();
  vi.useFakeTimers();
  try {
    await act(async () => block.click());
    expect(pane.scrollTop).toBe(0);
    expect(block.hasAttribute("data-focused")).toBe(true);
    expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b1", "parallel");
    const calls = vi.mocked(adapter.focusBlock!).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(pane.scrollTop).toBeGreaterThan(0);
    expect(pane.scrollTop).toBeLessThan(400);
    await act(async () => {
      pane.dispatchEvent(new Event("scroll", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(400);
    expect(block.hasAttribute("data-focused")).toBe(false);
    expect(adapter.focusBlock).toHaveBeenCalledTimes(calls);
    expect(adapter.followBlock).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("top-aligns tall translation blocks and cancels their motion when the user scrolls", async () => {
  await click("仅译文");
  const { pane, block } = translationGeometry(800);
  vi.useFakeTimers();
  try {
    await act(async () => block.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(600);
    expect(adapter.followBlock).not.toHaveBeenCalled();
    pane.scrollTop = 0;
    await act(async () => block.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(96);
    });
    await act(async () =>
      pane.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: 30 }),
      ),
    );
    pane.scrollTop = 75;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(75);
  } finally {
    vi.useRealTimers();
  }
});
it("does not treat drags, native selections or interactive controls as block navigation", async () => {
  await click("原文译文");
  const { pane, block } = translationGeometry();
  await act(async () => {
    block.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 10,
        clientY: 10,
      }),
    );
    block.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 }),
    );
    block.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: 40,
        clientY: 40,
        detail: 1,
      }),
    );
  });
  const button = document.createElement("button");
  block.append(button);
  await act(async () => button.click());
  const range = document.createRange();
  range.selectNodeContents(block.querySelector("p")!);
  window.getSelection()!.addRange(range);
  await act(async () => block.click());
  expect(adapter.followBlock).not.toHaveBeenCalled();
  expect(pane.scrollTop).toBe(0);
});

it("replaces an unfinished click with an image focus and does not re-highlight on scroll", async () => {
  await renderView(defaultTheme, [
    {
      id: "p1-image",
      page: 1,
      label: "chart",
      text: "",
      image: "figure.png",
      bounds: { x: 0.55, y: 0.4, width: 0.3, height: 0.2 },
    },
  ]);
  await click("原文译文");
  const { pane, block } = translationGeometry();
  const image = pane.querySelector<HTMLElement>(
    '[data-translation-block="p1-image"]',
  )!;
  image.getBoundingClientRect = () =>
    new DOMRect(40, 1000 - pane.scrollTop, 520, 200);
  vi.useFakeTimers();
  try {
    await act(async () => block.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(96);
    });
    const before = pane.scrollTop;
    await act(async () => image.querySelector("img")!.click());
    expect(pane.scrollTop).toBe(before);
    expect(block.hasAttribute("data-focused")).toBe(false);
    expect(image.hasAttribute("data-focused")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(800);
    expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-image", "parallel");
    await act(async () => {
      host
        .querySelector(".translation-source")!
        .dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 }));
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.5 });
    });
    expect(block.hasAttribute("data-focused")).toBe(false);
    expect(image.hasAttribute("data-focused")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it("does not focus during manual scrolling and cancels keyboard focus when the pane closes", async () => {
  await click("仅译文");
  const { pane, block } = translationGeometry();
  vi.useFakeTimers();
  try {
    await act(async () => {
      pane.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: 30 }),
      );
      pane.dispatchEvent(new Event("scroll", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(32);
    });
    expect(block.hasAttribute("data-focused")).toBe(false);
    await act(async () =>
      block.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(96);
    });
    expect(pane.scrollTop).toBeGreaterThan(0);
    const top = pane.scrollTop;
    await click("仅原文");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(pane.scrollTop).toBe(top);
    expect(host.querySelector(".translation-document")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("centers both panels from a source click and recalculates a focused translation after resizing", async () => {
  await click("原文译文");
  const { pane, block } = translationGeometry(800);
  let width = 600,
    height = 600,
    blockHeight = 800;
  Object.defineProperties(pane, {
    clientWidth: { get: () => width, configurable: true },
    clientHeight: { get: () => height, configurable: true },
    scrollWidth: { value: 1600, configurable: true },
  });
  pane.getBoundingClientRect = () => new DOMRect(50, 20, width, height);
  block.getBoundingClientRect = () =>
    new DOMRect(150 - pane.scrollLeft, 620 - pane.scrollTop, 400, blockHeight);
  const sourceBlock = {
    id: "p1-b1",
    page: 1,
    bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
  } as PDFBlock;
  vi.useFakeTimers();
  try {
    await act(async () => fixture.events!.blockFocus?.(sourceBlock));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(600); // tall translation top, independent of short original
    expect(adapter.focusBlock).toHaveBeenLastCalledWith("p1-b1", "parallel");
    await act(async () => {
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.5 });
      pane.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(32);
    });
    expect(pane.scrollTop).toBe(600); // late programmatic events cannot recenter it
    width = 400;
    height = 500;
    blockHeight = 200;
    await act(async () => block.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(pane.scrollTop).toBe(450);
    expect(pane.scrollLeft).toBe(100);
    expect(adapter.focusBlock).toHaveBeenCalledTimes(2);
    expect(adapter.followBlock).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "centers the current block after the translation pane expands instead of scrolling to the bottom (reduced motion: %s)",
  async (reduced) => {
    vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
    await renderView(defaultTheme, [
      {
        id: "p1-b2",
        page: 1,
        label: "text",
        text: "Middle paragraph.",
        bounds: { x: 0.1, y: 0.55, width: 0.3, height: 0.1 },
      },
    ]);
    await act(async () =>
      fixture.events!.readingAnchor?.({ blockId: "p1-b2", fraction: 0.5 }),
    );
    // The resizable pane starts collapsed. Text wraps until its new width commits.
    let expanded = false,
      top = 0;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("translation-document"))
          return new DOMRect(600, 0, expanded ? 600 : 0, 600);
        if (this.dataset.translationBlock)
          return new DOMRect(
            640,
            (this.dataset.translationBlock === "p1-b2"
              ? expanded
                ? 1000
                : 6000
              : 300) - top,
            expanded ? 520 : 1,
            expanded ? 200 : 5700,
          );
        return originalRect.call(this);
      });
    const height = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(600);
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(() => (expanded ? 600 : 0));
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(() => (expanded ? 2400 : 12000));
    const scroll = vi
      .spyOn(HTMLElement.prototype, "scrollTop", "get")
      .mockImplementation(() => top);
    const setScroll = vi
      .spyOn(HTMLElement.prototype, "scrollTop", "set")
      .mockImplementation((value) => {
        top = Math.max(0, Math.min(value, expanded ? 1800 : 11400));
      });
    vi.useFakeTimers();
    try {
      await click("原文译文");
      expanded = true;
      await act(async () =>
        fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0 }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(adapter.adjustZoom).toHaveBeenCalledWith("width");
      expect(adapter.focusBlock).not.toHaveBeenCalled();
      expect(adapter.followBlock).toHaveBeenCalledWith({
        blockId: "p1-b2",
        fraction: 0.5,
      });
      expect(top).toBe(800);
    } finally {
      vi.useRealTimers();
      for (const spy of [rect, height, width, scrollHeight, scroll, setScroll])
        spy.mockRestore();
    }
  },
);

it.each(["mode", "wheel"])(
  "cancels queued mode centering on fresh %s input",
  async (action) => {
    await act(async () =>
      fixture.events!.readingAnchor?.({ blockId: "p1-b1", fraction: 0.5 }),
    );
    vi.useFakeTimers();
    try {
      await click("原文译文");
      expect(adapter.focusBlock).not.toHaveBeenCalled();
      if (action === "mode") await click("仅原文");
      else
        await act(async () =>
          host
            .querySelector(".translation-source")!
            .dispatchEvent(
              new WheelEvent("wheel", { bubbles: true, deltaY: 50 }),
            ),
        );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(adapter.focusBlock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  },
);
